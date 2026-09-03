export type MinimumStability = '稳定' | '一般' | '不稳';

const ALPHA123_STABILITY_FEED_URL = 'https://alpha123.uk/stability/stability_feed_v3.json';
const ALPHA123_FETCH_TIMEOUT_MS = 10_000;

type Alpha123Feed = {
  items?: Array<{n?: unknown; st?: unknown; md?: unknown; ps?: unknown}>;
};

type StabilityGateConfig = {
  tokenSymbol: string;
  minimumStability: MinimumStability;
  maximumForecastWear: number;
};

type Alpha123FeedFetcher = (input: string, init?: RequestInit) => Promise<Response>;

type StabilityGateRetryOptions = {
  fetcher?: Alpha123FeedFetcher;
  maxAttempts?: number;
  retryDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
};

export type StabilityGateAllowed = {
  outcome: 'allow';
  stability: MinimumStability;
  fourXDays: number;
  forecastWear: number;
};

export type StabilityGateContinueMonitoring = {
  outcome: 'continue-monitoring';
  reason: string;
  stability: MinimumStability;
  fourXDays: number;
  forecastWear: number;
};

const stabilityFromStatus = (status: unknown): MinimumStability | null => {
  if (status === 'green:stable') return '稳定';
  if (status === 'yellow:moderate') return '一般';
  if (status === 'red:unstable') return '不稳';
  return null;
};

const stabilityRank: Record<MinimumStability, number> = {不稳: 0, 一般: 1, 稳定: 2};

const ALPHA123_MAX_ATTEMPTS = 3;
const ALPHA123_RETRY_DELAY_MS = 1_000;
export const ALPHA123_UNAVAILABLE_RECOVERY_WAIT_MS = 20_000;

const defaultWait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

export const isAlpha123UnavailableDataError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Alpha123 看板数据不可用：');
};

const isRetryableAlpha123Error = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Alpha123 看板请求失败') || message.includes('Alpha123 看板返回数据不可解析');
};

export const fetchAlpha123StabilityFeed = async (fetcher: Alpha123FeedFetcher = fetch): Promise<Alpha123Feed> => {
  let response: Response;
  try {
    response = await fetcher(ALPHA123_STABILITY_FEED_URL, {signal: AbortSignal.timeout(ALPHA123_FETCH_TIMEOUT_MS)});
  } catch {
    throw new Error('Alpha123 看板请求失败');
  }
  if (!response.ok) throw new Error(`Alpha123 看板请求失败：HTTP ${response.status}`);
  try {
    const data = await response.json();
    if (!data || typeof data !== 'object' || !Array.isArray((data as Alpha123Feed).items)) throw new Error('invalid feed');
    return data as Alpha123Feed;
  } catch {
    throw new Error('Alpha123 看板返回数据不可解析');
  }
};

export type Alpha123StabilityGateResult = StabilityGateAllowed | StabilityGateContinueMonitoring;

export const evaluateAlpha123StabilityGateWithRetry = async (
  config: StabilityGateConfig,
  options: StabilityGateRetryOptions = {},
): Promise<Alpha123StabilityGateResult> => {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? ALPHA123_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? ALPHA123_RETRY_DELAY_MS);
  const wait = options.wait ?? defaultWait;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return evaluateStabilityGate(await fetchAlpha123StabilityFeed(options.fetcher), config);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryableAlpha123Error(error)) throw error;
      await wait(retryDelayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

export const waitForAlpha123UnavailableDataRecovery = async (
  error: unknown,
  wait: (milliseconds: number) => Promise<void>,
): Promise<boolean> => {
  if (!isAlpha123UnavailableDataError(error)) return false;
  await wait(ALPHA123_UNAVAILABLE_RECOVERY_WAIT_MS);
  return true;
};

export const evaluateStabilityGate = (feed: Alpha123Feed, config: StabilityGateConfig): Alpha123StabilityGateResult => {
  const token = config.tokenSymbol.trim().toUpperCase();
  const item = feed.items?.find(candidate => String(candidate.n || '').split('/')[0]?.toUpperCase() === token);
  if (!item) throw new Error(`Alpha123 看板未找到当前市场代币 ${token}`);

  const stability = stabilityFromStatus(item.st);
  if (item.md === '1x') throw new Error(`Alpha123 看板 4倍天数为 1x：${token}`);
  const fourXDays = Number(item.md);
  const forecastWear = Number(item.ps);
  if (!stability || !Number.isFinite(fourXDays) || !Number.isFinite(forecastWear)) {
    throw new Error(`Alpha123 看板数据不可用：${token}`);
  }
  if (fourXDays <= 0) {
    return {
      outcome: 'continue-monitoring',
      reason: `4倍天数 ${fourXDays} 不大于 0`,
      stability,
      fourXDays,
      forecastWear,
    };
  }
  if (stabilityRank[stability] < stabilityRank[config.minimumStability]) {
    return {
      outcome: 'continue-monitoring',
      reason: `稳定度 ${stability} 未达到最低稳定度 ${config.minimumStability}`,
      stability,
      fourXDays,
      forecastWear,
    };
  }
  if (forecastWear >= config.maximumForecastWear) {
    return {
      outcome: 'continue-monitoring',
      reason: `预估磨损 ${forecastWear} 不小于最高预估磨损 ${config.maximumForecastWear}`,
      stability,
      fourXDays,
      forecastWear,
    };
  }
  return {outcome: 'allow', stability, fourXDays, forecastWear};
};
