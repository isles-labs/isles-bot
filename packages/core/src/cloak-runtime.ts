import type {CloakScriptContext, CloakScriptDefinition, CloakWindowBinding} from './cloak-script.js';

type RuntimePayload = {
  run?: {id?: string; windowId?: string; windowName?: string};
  config?: Record<string, unknown>;
  steps?: Array<{id: string; label: string}>;
};

const readPayload = (): RuntimePayload => {
  try {
    return JSON.parse(process.env.CLOAK_SCRIPT_CONTEXT || '{}') as RuntimePayload;
  } catch {
    return {};
  }
};

const writeLog = (level: string, message: string, metadata?: Record<string, unknown>) => {
  console.log(JSON.stringify({cloak_event: 'log', level, message, metadata}));
};

const isDevelopmentRun = () => process.env.CLOAK_SCRIPT_DEVELOPMENT === '1';
const isLocalRun = () => process.env.CLOAK_SCRIPT_LOCAL === '1';

const writeDevelopmentEvent = (event: string, metadata?: Record<string, unknown>) => {
  if (isDevelopmentRun() || isLocalRun()) console.log(JSON.stringify({cloak_event: event, ...metadata}));
};

const apiRequest = async <T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> => {
  const localApiUrl = process.env.CLOAK_LOCAL_API_URL;
  const localApiToken = process.env.CLOAK_LOCAL_API_TOKEN;
  if (isLocalRun() && localApiUrl && localApiToken) {
    const response = await fetch(`${localApiUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${localApiToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json() as {success?: boolean; data?: T; message?: string};
    if (!response.ok || !payload.success) throw new Error(payload.message || `本机数据台请求失败 (${response.status})`);
    return payload.data as T;
  }
  const baseUrl = process.env.CLOAK_SCRIPT_API_BASE_URL;
  const workspaceId = process.env.CLOAK_SCRIPT_WORKSPACE_ID;
  const deviceId = process.env.CLOAK_SCRIPT_DEVICE_ID;
  if (!baseUrl || !workspaceId) throw new Error('脚本 Runtime 未连接到团队数据台');
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(process.env.CLOAK_SCRIPT_ACCESS_TOKEN ? {authorization: `Bearer ${process.env.CLOAK_SCRIPT_ACCESS_TOKEN}`} : {}),
      'x-workspace-id': workspaceId,
      ...(deviceId ? {'x-device-id': deviceId} : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json() as {success?: boolean; data?: T; message?: string};
  if (!response.ok || !payload.success) throw new Error(payload.message || `数据台请求失败 (${response.status})`);
  return payload.data as T;
};

/**
 * Runtime supplied by Isles Browser for a single approved window task.
 * It deliberately has no shell, CDP address or credential access.
 */
export const createCloakRuntimeContext = (): CloakScriptContext => {
  const payload = readPayload();
  const signalController = new AbortController();
  const abort = () => signalController.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const window: CloakWindowBinding = {
    id: payload.run?.windowId || process.env.CLOAK_SCRIPT_WINDOW_KEY || '',
    name: payload.run?.windowName || process.env.CLOAK_SCRIPT_WINDOW_NAME || '未命名窗口',
  };
  const isWindowJob = Boolean(window.id);
  const scriptId = process.env.CLOAK_SCRIPT_ID || '';
  const emitStep = async (id: string, status: string, details?: Record<string, unknown>) => {
    const definition = payload.steps?.find(step => step.id === id);
    if (!definition) throw new Error(`当前脚本未声明步骤：${id}`);
    if (isDevelopmentRun() || isLocalRun()) {
      writeDevelopmentEvent('step', {id, label: definition.label, status, details});
      return;
    }
    await apiRequest('POST', `/script-center/runs/${encodeURIComponent(payload.run?.id || process.env.CLOAK_SCRIPT_RUN_ID || '')}/steps`, {
      step_id: id,
      step_label: definition.label,
      status,
      details,
    });
  };
  const readRecords = async (tableId: string, limit?: number) => {
    const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
    const runId = encodeURIComponent(payload.run?.id || process.env.CLOAK_SCRIPT_RUN_ID || '');
    const localPath = `/script-center/local/runs/${runId}/records/${encodeURIComponent(scriptId)}/${encodeURIComponent(tableId)}${query}`;
    return await apiRequest<Array<{id: string; record_key: string; data: Record<string, unknown>; revision: number}>>(
      'GET', isLocalRun() ? localPath : `/script-center/records/${encodeURIComponent(scriptId)}/${encodeURIComponent(tableId)}${query}`,
    );
  };
  return {
    config: {get: <T = unknown>(key: string) => (payload.config || {})[key] as T},
    data: {
      query: async (tableId, options) => {
        const filter = options?.filter || {};
        const records: Array<Record<string, unknown>> = (await readRecords(tableId, options?.limit)).map(record => ({
          recordKey: record.record_key,
          ...record.data,
        }));
        return records.filter(record => Object.entries(filter).every(([key, value]) => record[key] === value));
      },
      upsert: async (tableId, recordKey, data) => {
        const runId = encodeURIComponent(payload.run?.id || process.env.CLOAK_SCRIPT_RUN_ID || '');
        await apiRequest('POST', isLocalRun()
          ? `/script-center/local/runs/${runId}/records/${encodeURIComponent(scriptId)}/${encodeURIComponent(tableId)}`
          : `/script-center/records/${encodeURIComponent(scriptId)}/${encodeURIComponent(tableId)}`, {
          record_key: recordKey,
          data,
        });
      },
      update: async (tableId, recordKey, patch) => {
        const existing = (await readRecords(tableId)).find(record => record.record_key === recordKey);
        if (!existing) throw new Error(`找不到数据记录 ${recordKey}`);
        const runId = encodeURIComponent(payload.run?.id || process.env.CLOAK_SCRIPT_RUN_ID || '');
        await apiRequest('PATCH', isLocalRun()
          ? `/script-center/local/runs/${runId}/records/${encodeURIComponent(scriptId)}/${encodeURIComponent(tableId)}`
          : `/script-center/records/${encodeURIComponent(existing.id)}`, {
          ...(isLocalRun() ? {record_key: recordKey} : {revision: existing.revision}),
          data: {...existing.data, ...patch},
        });
      },
    },
    metrics: {
      record: async (values, options = {}) => {
        if (isDevelopmentRun()) {
          writeDevelopmentEvent('metric', {
            values,
            status: options.status || 'success',
            occurredAt: options.occurredAt,
          });
          return;
        }
        const runId = encodeURIComponent(payload.run?.id || process.env.CLOAK_SCRIPT_RUN_ID || '');
        await apiRequest('POST', isLocalRun()
          ? `/script-center/local/runs/${runId}/metrics`
          : `/script-center/runs/${runId}/metrics`, {
          values,
          status: options.status || 'success',
          occurred_at: options.occurredAt,
        });
      },
    },
    windows: {
      get: async () => {
        if (!isWindowJob) throw new Error('无窗口任务不能读取当前指纹窗口');
        return window;
      },
      connect: async () => {
        if (!isWindowJob) throw new Error('无窗口任务不能连接指纹窗口');
        const cdpUrl = process.env.CLOAK_SCRIPT_WINDOW_CDP_URL;
        if (!cdpUrl) throw new Error('目标窗口没有可用的浏览器连接');
        const {connectPlaywrightOverCdp} = await import('@auto-bot/browser');
        return await connectPlaywrightOverCdp(cdpUrl);
      },
    },
    logger: {
      debug: (message, metadata) => writeLog('debug', message, metadata),
      info: (message, metadata) => writeLog('info', message, metadata),
      warn: (message, metadata) => writeLog('warn', message, metadata),
      error: (message, metadata) => writeLog('error', message, metadata),
    },
    steps: {
      start: async (id, details) => await emitStep(id, 'running', details),
      succeed: async (id, details) => await emitStep(id, 'succeeded', details),
      fail: async (id, error, details) => await emitStep(id, 'failed', {
        ...details,
        error: error instanceof Error ? error.message : error,
      }),
      skip: async (id, reason) => await emitStep(id, 'skipped', reason ? {reason} : undefined),
    },
    notify: async input => {
      if (isLocalRun()) {
        const runId = encodeURIComponent(payload.run?.id || process.env.CLOAK_SCRIPT_RUN_ID || '');
        await apiRequest('POST', `/script-center/local/runs/${runId}/notifications`, input);
        return;
      }
      console.log(JSON.stringify({cloak_event: 'notify', development: isDevelopmentRun(), ...input}));
    },
    signal: signalController.signal,
  };
};

export async function runCloakScript(
  script: CloakScriptDefinition,
  context: CloakScriptContext = createCloakRuntimeContext(),
): Promise<void> {
  let errorNotificationSent = false;
  const notify = context.notify;
  const wrappedContext: CloakScriptContext = {
    ...context,
    notify: async input => {
      await notify(input);
      if (input.level === 'error' || input.level === 'critical') errorNotificationSent = true;
    },
  };

  try {
    await script.run(wrappedContext);
  } catch (error) {
    if (!errorNotificationSent) {
      const reason = error instanceof Error ? error.message : String(error);
      const windowName = await context.windows.get().then(window => window.name).catch(() => '未命名窗口');
      await notify({
        level: 'error',
        title: `${script.name} 执行失败`,
        message: `窗口：${windowName}\n错误：${reason}\n请检查指纹浏览器窗口、网络和脚本配置后重试。`,
      }).catch(() => undefined);
    }
    throw error;
  }
}
