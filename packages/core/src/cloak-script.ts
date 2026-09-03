/**
 * Public contract between an automation script and Isles Browser.
 *
 * The Browser renders configuration and data views from this declaration; it
 * does not allow scripts to expose arbitrary shell commands to end users.
 */
interface CloakRunnerDefinition {
  command: 'node' | 'pnpm';
  args: string[];
}

export interface CloakWindowBinding {
  id: string;
  name: string;
}

export interface CloakWindowSession {
  browser: unknown;
  context: unknown;
  page: unknown;
  close(): Promise<void>;
}

export interface CloakScriptContext {
  config: {
    get<T = unknown>(key: string): T;
  };
  data: {
    query(tableId: string, options?: {limit?: number; filter?: Record<string, unknown>}): Promise<Array<Record<string, unknown>>>;
    upsert(tableId: string, recordKey: string, data: Record<string, unknown>): Promise<void>;
    update(tableId: string, recordKey: string, patch: Record<string, unknown>): Promise<void>;
  };
  metrics: {
    record(values: Record<string, number>, options?: {status?: 'success' | 'failed'; occurredAt?: string}): Promise<void>;
  };
  windows: {
    get(windowId?: string): Promise<CloakWindowBinding>;
    connect(windowId?: string): Promise<CloakWindowSession>;
  };
  logger: {
    debug(message: string, metadata?: Record<string, unknown>): void;
    info(message: string, metadata?: Record<string, unknown>): void;
    warn(message: string, metadata?: Record<string, unknown>): void;
    error(message: string, metadata?: Record<string, unknown>): void;
  };
  steps: {
    start(id: string, details?: Record<string, unknown>): Promise<void>;
    succeed(id: string, details?: Record<string, unknown>): Promise<void>;
    fail(id: string, error: Error | string, details?: Record<string, unknown>): Promise<void>;
    skip(id: string, reason?: string): Promise<void>;
  };
  notify: (input: {
    level: 'debug' | 'info' | 'warning' | 'error' | 'critical';
    title: string;
    message: string;
  }) => Promise<void>;
  signal: AbortSignal;
}

export interface CloakScriptDefinition {
  id: string;
  name: string;
  version: string;
  type: 'window-job';
  execution: {
    targets: ['local'];
    requiresWindow: true;
    windowConcurrency: number;
    closeWindowOnSuccess: boolean;
  };
  runner: CloakRunnerDefinition;
  steps: Array<{id: string; label: string}>;
  dataModel: {tables: []};
  run(context: CloakScriptContext): Promise<void>;
}

export function defineCloakScript(definition: CloakScriptDefinition): CloakScriptDefinition {
  if (!definition.id || !definition.name || !definition.version) {
    throw new Error('Cloak script id, name and version are required');
  }
  if (!definition.runner || !['node', 'pnpm'].includes(definition.runner.command)) {
    throw new Error(`Cloak script ${definition.id} must declare a supported runner command`);
  }
  return definition;
}
