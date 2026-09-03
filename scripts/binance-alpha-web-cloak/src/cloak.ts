import {createCloakRuntimeContext, defineCloakScript, type CloakScriptContext} from '@auto-bot/core';
import {humanizePlaywrightPage, resolveHumanizeOptions} from '@auto-bot/browser';
import type {Page} from 'playwright-core';
import {AlphaLoginRequiredError, AlphaOrderResultTimeoutError, AlphaPageStateError, BinanceAlphaWebAction, type AlphaPageConfig} from './action.js';
import {analyzeOpportunity, type ObservedTrade, type StrategyConfig} from './strategy.js';
import {BinanceAlphaOrderPageAdapter, findIncompleteCurrentMarketOrderIds, findSubmittedOrders, historyBusinessDate, postToastRecovery, summarizeCurrentMarketVolume} from './order-page-adapter.js';
import {evaluateAlpha123StabilityGateWithRetry, waitForAlpha123UnavailableDataRecovery, type Alpha123StabilityGateResult, type MinimumStability, type StabilityGateAllowed, type StabilityGateContinueMonitoring} from './stability-dashboard.js';
import {isVolumeTargetComplete, nextTransactionAmount} from './trade-volume.js';

const TABLE_ID = 'window-state';
const FINAL_BALANCE_SETTLEMENT_WAIT_MS = 5_000;
const POST_CANCEL_CURRENT_ORDER_RECHECK_MS = 5_000;
export const ALPHA123_MONITOR_REFRESH_INTERVAL_MS = 2_000;

type WindowState = {
  recordKey: string;
  marketUrl?: string;
  transactionAmount?: number | string;
  targetAccumulatedVolume?: number | string;
  completedDate?: string;
  initialBalance?: number | string;
  finalBalance?: number | string;
  accumulatedVolume?: number | string;
  wear?: number | string;
  businessStatus?: string;
  lastStrategy?: string;
  lastError?: string;
  lastRunAt?: string;
};

const persistedWindowState = (state: WindowState): WindowState => ({
  recordKey: state.recordKey,
  marketUrl: state.marketUrl,
  transactionAmount: state.transactionAmount,
  targetAccumulatedVolume: state.targetAccumulatedVolume,
  accumulatedVolume: state.accumulatedVolume,
  completedDate: state.completedDate,
  initialBalance: state.initialBalance,
  finalBalance: state.finalBalance,
  wear: state.wear,
  businessStatus: state.businessStatus,
  lastStrategy: state.lastStrategy,
  lastError: state.lastError,
  lastRunAt: state.lastRunAt,
});

export const availableBalancePatch = (
  key: 'initialBalance' | 'finalBalance',
  balance: number | null,
): Partial<WindowState> => balance === null ? {} : {[key]: balance};

export const calculateWear = (initialBalance: number | null, finalBalance: number | null): number | null =>
  initialBalance === null || finalBalance === null ? null : Number((initialBalance - finalBalance).toFixed(8));

export const shouldCaptureFinalBalance = (error: unknown) => !(error instanceof AlphaLoginRequiredError);

export const initialBalancePatch = (state: WindowState, runDate: string, balance: number | null): Partial<WindowState> => {
  const hasInitialBalanceToday = state.completedDate === runDate
    && state.initialBalance !== undefined
    && state.initialBalance !== null
    && String(state.initialBalance).trim() !== '';
  return hasInitialBalanceToday ? {} : availableBalancePatch('initialBalance', balance);
};

export const failureResultPatch = (
  state: WindowState,
  runDate: string,
  accumulatedVolume: number,
  lastError: string,
): Partial<WindowState> => {
  const hasInitialBalanceToday = state.completedDate === runDate
    && state.initialBalance !== undefined
    && state.initialBalance !== null
    && String(state.initialBalance).trim() !== '';
  return {
    ...(hasInitialBalanceToday ? {completedDate: runDate} : {}),
    accumulatedVolume,
    businessStatus: '执行失败',
    lastError,
  };
};

export const captureAvailableBalance = async (
  key: 'initialBalance' | 'finalBalance',
  read: () => Promise<number | null>,
  persist: (patch: Partial<WindowState>) => Promise<void>,
) => {
  const balance = await read();
  const patch = availableBalancePatch(key, balance);
  if (Object.keys(patch).length > 0) await persist(patch);
  return balance;
};

export const captureFinalBalanceAfterSettlement = async (
  wait: (milliseconds: number) => Promise<void>,
  capture: () => Promise<number | null>,
) => {
  await wait(FINAL_BALANCE_SETTLEMENT_WAIT_MS);
  return await capture();
};

export const awaitAlpha123Gate = async (
  readGate: () => Promise<Alpha123StabilityGateResult>,
  options: {
    pollIntervalMs: number;
    wait: (milliseconds: number) => Promise<void>;
    onRejected: (gate: StabilityGateContinueMonitoring) => Promise<void>;
    onUnavailable?: (error: unknown) => Promise<void>;
    isAborted?: () => boolean;
  },
): Promise<StabilityGateAllowed> => {
  while (!options.isAborted?.()) {
    try {
      const gate = await readGate();
      if (gate.outcome === 'allow') return gate;
      await options.onRejected(gate);
      await options.wait(options.pollIntervalMs);
    } catch (error) {
      if (!await waitForAlpha123UnavailableDataRecovery(error, options.wait)) throw error;
      await options.onUnavailable?.(error);
    }
  }
  throw new Error('任务已取消');
};

export const isAlpha123StabilityRefreshDue = (nextRefreshAt: number, now = Date.now()) => now >= nextRefreshAt;

const numberConfig = (context: CloakScriptContext, key: string, fallback: number, minimum = Number.NEGATIVE_INFINITY) => {
  const value = Number(context.config.get(key) ?? fallback);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`配置 ${key} 无效`);
  return value;
};

const textConfig = (context: CloakScriptContext, key: string, fallback: string) => {
  const value = String(context.config.get(key) ?? fallback).trim();
  if (!value) throw new Error(`配置 ${key} 不能为空`);
  return value;
};

const positiveNumber = (value: unknown, label: string) => {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${label}必须是大于 0 的数字`);
  return result;
};

const positiveInteger = (value: unknown, label: string) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${label}必须是大于 0 的整数`);
  return result;
};

const failureSummary = (error: unknown) => {
  if (error instanceof AlphaLoginRequiredError) return '当前账户需要重新登录';
  if (error instanceof AlphaOrderResultTimeoutError) return '订单成交核验超时，请检查 Binance Alpha 页面中的挂单和成交状态';
  if (error instanceof AlphaPageStateError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (/Target page, context or browser has been closed/i.test(message)) return '指纹浏览器页面或自动化连接已关闭';
  if (/timeout/i.test(message)) return '页面元素或行情数据等待超时，请检查登录状态、市场页面和页面布局';
  return message;
};

const buildPageConfig = (context: CloakScriptContext): AlphaPageConfig => ({
  tradeTabSelector: textConfig(context, 'tradeTabSelector', '#bn-tab-transactions'),
  tradePanelSelector: textConfig(context, 'tradePanelSelector', '#bn-tab-pane-transactions'),
  tradeListSelector: textConfig(context, 'tradeListSelector', 'div[aria-label="grid"].ReactVirtualized__List .ReactVirtualized__Grid__innerScrollContainer'),
  orderFormSelector: textConfig(context, 'orderFormSelector', 'div.md\\:rounded-\\[8px\\]:has(#limitPrice), form:has(#limitPrice)'),
  limitPriceSelector: textConfig(context, 'limitPriceSelector', '#limitPrice, input[name*="price" i]'),
  reverseSellPriceSelector: textConfig(context, 'reverseSellPriceSelector', 'input[placeholder*="限价卖"], input[name*="sell" i]'),
  turnoverSelector: textConfig(context, 'turnoverSelector', '#limitTotal, input[name*="total" i]'),
  buyButtonSelector: textConfig(context, 'buyButtonSelector', 'button[class*="buy" i], .bn-button__buy'),
  reverseOrderText: textConfig(context, 'reverseOrderText', '反向订单'),
  confirmButtonText: textConfig(context, 'confirmButtonText', '确认'),
  buyFilledText: textConfig(context, 'buyFilledText', '限价买单已成交'),
  sellFilledText: textConfig(context, 'sellFilledText', '限价卖单已成交'),
  confirmButtonTimeoutMs: numberConfig(context, 'confirmButtonTimeoutMs', 15_000, 1_000),
  formControlTimeoutMs: numberConfig(context, 'formControlTimeoutMs', 15_000, 1_000),
  balanceSelector: textConfig(context, 'balanceSelector', 'div.bn-flex.text-TertiaryText.items-center.justify-between.w-full:has-text("可用")'),
  balanceText: textConfig(context, 'balanceText', '可用'),
  balanceAssetSymbol: textConfig(context, 'balanceAssetSymbol', 'USDT'),
  balanceReadTimeoutMs: numberConfig(context, 'balanceReadTimeoutMs', 10_000, 0),
  requireBalanceCheck: Boolean(context.config.get('requireBalanceCheck') ?? true),
  pollIntervalMs: numberConfig(context, 'pollIntervalMs', 1_000, 100),
  orderResultTimeoutMs: numberConfig(context, 'orderResultTimeoutMs', 30_000, 1_000),
  toastOnlyWindowMs: numberConfig(context, 'toastOnlyWindowMs', 5_000, 100),
  orderSubmitRetries: positiveInteger(context.config.get('orderSubmitRetries') ?? 3, '买入按钮重试次数'),
  buyPriceOffsetBps: numberConfig(context, 'buyPriceOffsetBps', 10, 0),
  sellPriceOffsetBps: numberConfig(context, 'sellPriceOffsetBps', 10, 0),
  autoConfirm: Boolean(context.config.get('autoConfirm') ?? false),
  enableWebSocketFeed: Boolean(context.config.get('enableWebSocketFeed') ?? true),
  securityVerificationSelector: textConfig(context, 'securityVerificationSelector', '[data-e2e="page-title"]:has-text("安全验证")'),
  navigationRetryTimeoutMs: numberConfig(context, 'navigationRetryTimeoutMs', 3_000, 0),
  sellButtonSelector: textConfig(context, 'sellButtonSelector', 'button:has-text("卖出"), button[class*="sell" i]'),
  buyTabSelector: textConfig(context, 'buyTabSelector', '[role="tab"]:has-text("买入")'),
  sellTabSelector: textConfig(context, 'sellTabSelector', '[role="tab"]:has-text("卖出")'),
  sellQuantitySelector: textConfig(context, 'sellQuantitySelector', textConfig(context, 'turnoverSelector', '#limitTotal, input[name*="total" i]')),
});

const buildHumanizeConfig = (context: CloakScriptContext) => {
  const configuredPreset = String(context.config.get('humanizePreset') ?? 'normal');
  const preset = configuredPreset === 'careful' ? 'careful' : 'normal';
  return {preset, options: resolveHumanizeOptions(preset)};
};

const buildStrategyConfig = (context: CloakScriptContext): StrategyConfig => ({
  windowSeconds: positiveInteger(context.config.get('strategyWindowSeconds') ?? 30, '策略窗口秒数'),
  minimumSamples: positiveInteger(context.config.get('minimumSamples') ?? 5, '最小样本数'),
  uptrendThreshold: numberConfig(context, 'uptrendThreshold', 0.58, 0),
  sidewaysThreshold: numberConfig(context, 'sidewaysThreshold', 0.62, 0),
  minVolatilityPercent: numberConfig(context, 'minVolatilityPercent', 0.008, 0),
  maxVolatilityPercent: numberConfig(context, 'maxVolatilityPercent', 0.05, 0),
  sidewaysMaxRangePercent: numberConfig(context, 'sidewaysMaxRangePercent', 0.015, 0),
  targetSpreadBps: numberConfig(context, 'targetSpreadBps', 0.5, 0),
});

const buildStabilityGateConfig = (context: CloakScriptContext, tokenSymbol: string) => {
  const minimumStability = textConfig(context, 'minimumStability', '一般');
  if (minimumStability !== '稳定' && minimumStability !== '一般' && minimumStability !== '不稳') {
    throw new Error('配置 minimumStability 无效');
  }
  return {
    tokenSymbol,
    minimumStability: minimumStability as MinimumStability,
    maximumForecastWear: numberConfig(context, 'maximumForecastWear', 0.26, 0),
  };
};

export default defineCloakScript({
  id: 'binance-alpha-web-cloak', name: 'Binance Alpha 网页策略交易（脚本中心）', version: '0.4.0', type: 'window-job',
  execution: {targets: ['local'], requiresWindow: true, windowConcurrency: 1, closeWindowOnSuccess: false},
  runner: {command: 'pnpm', args: ['--filter', '@auto-bot/script-binance-alpha-web-cloak', 'run', 'start']},
  steps: [
    {id: 'prepare-window', label: '准备 Binance Alpha 页面'},
    {id: 'inspect-history', label: '核对今日历史委托'},
    {id: 'monitor-market', label: '监听市场并等待策略信号'},
    {id: 'submit-order', label: '提交反向限价订单'},
    {id: 'verify-result', label: '核验买卖订单成交'},
    {id: 'write-result', label: '写回执行结果'},
  ],
  dataModel: {tables: []},
  async run(context = createCloakRuntimeContext()) {
    const window = await context.windows.get();
    const records = await context.data.query(TABLE_ID, {filter: {recordKey: window.name}}) as WindowState[];
    const state = records.find(record => record.recordKey === window.name);
    if (!state) throw new Error(`窗口 ${window.name} 缺少 Binance Alpha 网页数据台记录`);
    const marketUrl = String(state.marketUrl || '').trim();
    if (!marketUrl) throw new Error('窗口未配置 Binance Alpha 市场地址');
    const transactionAmount = positiveNumber(state.transactionAmount, '每轮成交额');
    const targetAccumulatedVolume = positiveNumber(state.targetAccumulatedVolume, '目标累积交易量');
    const tokenSymbol = textConfig(context, 'tokenSymbol', '');
    const runDate = historyBusinessDate();
    let accumulatedVolume = 0;
    let initialAccumulatedVolume = 0;
    let completionMetrics: {volume: number} | null = null;
    let latestState = persistedWindowState(state);
    const persist = async (patch: Partial<WindowState>) => {
      latestState = {...latestState, ...patch, recordKey: window.name, lastRunAt: new Date().toISOString()};
      await context.data.upsert(TABLE_ID, window.name, latestState);
    };
    const session = await context.windows.connect();
    const page = session.page as Page;
    const humanize = buildHumanizeConfig(context);
    humanizePlaywrightPage(page, humanize.options);
    context.logger.info('已启用页面操作拟人化', {
      preset: humanize.preset,
      clickDelayMs: humanize.options.clickDelay,
      keyDelayMs: humanize.options.keyDelay,
      actionDelayMs: humanize.options.actionDelay,
      scrollSteps: humanize.options.scrollSteps,
    });
    const action = new BinanceAlphaWebAction(
      buildPageConfig(context),
      (message, details) => context.logger.info(message, details),
      humanize.options,
    );
    const strategyConfig = buildStrategyConfig(context);
    const stabilityGateConfig = buildStabilityGateConfig(context, tokenSymbol);
    const pageConfig = buildPageConfig(context);
    const orderAdapter = new BinanceAlphaOrderPageAdapter({
      orderTableSelector: textConfig(context, 'orderTableSelector', 'div.bn-web-table-container:has(th[aria-colindex="7"])'),
      positionTableSelector: textConfig(context, 'positionTableSelector', 'div.bn-web-table-container:has(th[aria-colindex="3"]):has(th:has-text("代币"))'),
      buyTabSelector: pageConfig.buyTabSelector,
      sellTabSelector: pageConfig.sellTabSelector,
      tokenSymbol,
      cancelTimeoutMs: numberConfig(context, 'cancelTimeoutMs', 10_000, 1_000),
      pollIntervalMs: numberConfig(context, 'orderPollIntervalMs', 1_000, 100),
      humanizeOptions: humanize.options,
    });
    let initialBalance: number | null = null;
    let terminalError: unknown = null;
    try {
      await context.steps.start('prepare-window');
      await action.openMarket(page, marketUrl);
      initialBalance = await action.readAvailableBalance(page);
      if (pageConfig.requireBalanceCheck && initialBalance === null) {
        throw new Error(`未读取到 ${pageConfig.balanceAssetSymbol} 可用余额；请确认“可用余额选择器”命中“${pageConfig.balanceText} 数字 ${pageConfig.balanceAssetSymbol}”所在节点，或调整余额相关配置`);
      }
      const initialPatch = initialBalancePatch(latestState, runDate, initialBalance);
      if (Object.keys(initialPatch).length > 0) await persist({...initialPatch, completedDate: runDate});
      await context.steps.succeed('prepare-window', {windowName: window.name, marketUrl, availableBalance: initialBalance ?? '未读取到'});

      await context.steps.start('inspect-history');
      const historyRows = await orderAdapter.readHistoryOrders(page);
      const historySummary = summarizeCurrentMarketVolume(historyRows, runDate, tokenSymbol);
      if (historySummary.unpairedBuyOrderIds.length > 0) {
        throw new Error(`存在未完成历史买单（${historySummary.unpairedBuyOrderIds.join(', ')}），请先人工处理对应持仓和卖单`);
      }
      if (historySummary.unreadableCompletedBuyOrderIds.length > 0) {
        throw new Error(`历史委托未读取到买单成交额（${historySummary.unreadableCompletedBuyOrderIds.join(', ')}），请检查页面后重试`);
      }
      accumulatedVolume = historySummary.accumulatedVolume;
      initialAccumulatedVolume = accumulatedVolume;
      context.logger.info('Binance Alpha 当前市场历史成交额统计', {runDate, tokenSymbol, targetAccumulatedVolume, ...historySummary});
      await persist({completedDate: runDate, accumulatedVolume, businessStatus: accumulatedVolume >= targetAccumulatedVolume ? `${runDate}完成` : `待执行 ${accumulatedVolume}/${targetAccumulatedVolume}`, lastError: ''});
      await context.steps.succeed('inspect-history', {accumulatedVolume, targetAccumulatedVolume});

      if (isVolumeTargetComplete({targetVolume: targetAccumulatedVolume, accumulatedVolume, completedSupplementalRound: false})) {
        await context.steps.skip('monitor-market', '今日目标已完成');
        await context.steps.skip('submit-order', '今日目标已完成');
        await context.steps.skip('verify-result', '今日目标已完成');
        await context.steps.start('write-result');
        await persist({completedDate: runDate, accumulatedVolume, businessStatus: `${runDate}完成`, lastError: ''});
        await context.steps.succeed('write-result');
        return;
      }

      const currentOrders = await orderAdapter.readOrders(page);
      const incompleteCurrentOrderIds = findIncompleteCurrentMarketOrderIds(currentOrders.rows, tokenSymbol);
      if (incompleteCurrentOrderIds.length > 0) {
        throw new Error(`存在未完成当前委托（${incompleteCurrentOrderIds.join(', ')}），请先人工处理后再运行`);
      }

      let round = 0;
      let completedSupplementalRound = false;
      while (true) {
        if (isVolumeTargetComplete({targetVolume: targetAccumulatedVolume, accumulatedVolume, completedSupplementalRound})) break;
        const amount = nextTransactionAmount({targetVolume: targetAccumulatedVolume, accumulatedVolume, transactionAmount});
        if (amount === null) break;
        round += 1;
        const availableBalance = round === 1 ? initialBalance : await action.readAvailableBalance(page);
        if (pageConfig.requireBalanceCheck && availableBalance === null) {
          throw new Error(`未读取到 ${pageConfig.balanceAssetSymbol} 可用余额，无法确认本轮成交额 ${amount}`);
        }
        if (availableBalance !== null && amount > availableBalance) throw new Error(`本轮成交额 ${amount} 大于页面可用余额 ${availableBalance}`);
        await context.steps.start('monitor-market', {round, accumulatedVolume, targetAccumulatedVolume, amount});
        await awaitAlpha123Gate(
          () => evaluateAlpha123StabilityGateWithRetry(stabilityGateConfig, {
            retryDelayMs: ALPHA123_MONITOR_REFRESH_INTERVAL_MS,
            wait: milliseconds => page.waitForTimeout(milliseconds),
          }),
          {
            pollIntervalMs: ALPHA123_MONITOR_REFRESH_INTERVAL_MS,
            wait: milliseconds => page.waitForTimeout(milliseconds),
            isAborted: () => context.signal.aborted,
            onRejected: async stabilityGate => {
              const reason = `Alpha123 看板未通过：${stabilityGate.reason}（稳定度 ${stabilityGate.stability}、4倍天数 ${stabilityGate.fourXDays}、预估磨损 ${stabilityGate.forecastWear}）`;
              context.logger.info(reason, {tokenSymbol, ...stabilityGate});
              await persist({businessStatus: '看板未通过，等待看板刷新', lastStrategy: reason, completedDate: runDate, accumulatedVolume});
            },
            onUnavailable: async error => {
              const reason = error instanceof Error ? error.message : String(error);
              context.logger.info(`${reason}，20秒后重试看板`, {tokenSymbol});
              await persist({businessStatus: '看板数据不可用，20秒后重试', lastStrategy: reason, completedDate: runDate, accumulatedVolume});
            },
          },
        );
        const history: ObservedTrade[] = [];
        let lastFingerprint = '';
        const strategyTimeoutMs = numberConfig(context, 'strategyTimeoutMs', 300_000, 1_000);
        let deadline = Date.now() + strategyTimeoutMs;
        let decision: ReturnType<typeof analyzeOpportunity> | undefined;
        let observedTradeCount = 0;
        let stabilityGateAllowed = true;
        let nextStabilityRefreshAt = Date.now() + ALPHA123_MONITOR_REFRESH_INTERVAL_MS;
        while (Date.now() < deadline && !context.signal.aborted) {
          const now = Date.now();
          if (!stabilityGateAllowed && now < nextStabilityRefreshAt) {
            await page.waitForTimeout(nextStabilityRefreshAt - now);
            continue;
          }
          if (isAlpha123StabilityRefreshDue(nextStabilityRefreshAt, now) || !stabilityGateAllowed) {
            let stabilityGate: Alpha123StabilityGateResult;
            try {
              stabilityGate = await evaluateAlpha123StabilityGateWithRetry(stabilityGateConfig, {
                retryDelayMs: ALPHA123_MONITOR_REFRESH_INTERVAL_MS,
                wait: milliseconds => page.waitForTimeout(milliseconds),
              });
            } catch (error) {
              if (!await waitForAlpha123UnavailableDataRecovery(error, milliseconds => page.waitForTimeout(milliseconds))) throw error;
              const reason = error instanceof Error ? error.message : String(error);
              context.logger.info(`${reason}，20秒后重试看板`, {tokenSymbol});
              await persist({businessStatus: '看板数据不可用，20秒后重置策略监听', lastStrategy: reason, completedDate: runDate, accumulatedVolume});
              history.length = 0;
              lastFingerprint = '';
              observedTradeCount = 0;
              decision = undefined;
              stabilityGateAllowed = false;
              deadline = Date.now() + strategyTimeoutMs;
              nextStabilityRefreshAt = Date.now();
              continue;
            }
            nextStabilityRefreshAt = Date.now() + ALPHA123_MONITOR_REFRESH_INTERVAL_MS;
            if (stabilityGate.outcome !== 'allow') {
              const reason = `Alpha123 看板未通过：${stabilityGate.reason}（稳定度 ${stabilityGate.stability}、4倍天数 ${stabilityGate.fourXDays}、预估磨损 ${stabilityGate.forecastWear}）`;
              context.logger.info(reason, {tokenSymbol, ...stabilityGate});
              await persist({businessStatus: '看板未通过，重置策略计时', lastStrategy: reason, completedDate: runDate, accumulatedVolume});
              history.length = 0;
              lastFingerprint = '';
              observedTradeCount = 0;
              decision = undefined;
              stabilityGateAllowed = false;
              deadline = Date.now() + strategyTimeoutMs;
              continue;
            }
            stabilityGateAllowed = true;
          }
          const trade = await action.readLatestTrade(page);
          if (trade) {
            const fingerprint = `${trade.price}|${trade.quantity}|${trade.side}`;
            if (fingerprint !== lastFingerprint) {
              lastFingerprint = fingerprint;
              history.push(trade);
              observedTradeCount += 1;
              decision = analyzeOpportunity(history, strategyConfig);
              await persist({
                businessStatus: `监听中 ${accumulatedVolume}/${targetAccumulatedVolume}`,
                lastStrategy: decision.reason,
                completedDate: runDate,
                accumulatedVolume,
              });
              if (decision.suitable) {
                break;
              }
            }
          }
          await page.waitForTimeout(pageConfig.pollIntervalMs);
        }
        if (context.signal.aborted) throw new Error('任务已取消');
        if (!decision?.suitable) {
          throw new Error(observedTradeCount === 0
            ? '策略等待超时：未从已打开的成交记录面板解析到有效成交，请检查成交记录面板和成交列表选择器'
            : `策略等待超时：${decision?.reason || '未达到可交易信号'}`);
        }
        await context.steps.succeed('monitor-market', {round, strategy: decision.strategy, confidence: decision.confidence, reason: decision.reason});

        await context.steps.start('submit-order', {round, price: decision.price});
        const submitStartedAt = Date.now();
        const order = await action.submitReverseOrder(page, {price: decision.price, amount});
        const submitFinishedAt = Date.now();
        await context.steps.succeed('submit-order', {round, buyPrice: order.buyPrice, sellPrice: order.sellPrice, autoConfirm: pageConfig.autoConfirm});

        await context.steps.start('verify-result', {round});
        const lifecycleDeadline = Date.now() + numberConfig(context, 'orderResultTimeoutMs', 30_000, 1_000);
        const toastOnlyDeadline = submitFinishedAt + pageConfig.toastOnlyWindowMs;
        let completed = false;
        let retryAfterCancellation = false;
        let buyFillToastSeen = false;
        let sellFillToastSeen = false;
        const bodyBeforeSubmit = order.bodyBeforeSubmit;
        while (Date.now() < lifecycleDeadline && !context.signal.aborted) {
          await action.assertAuthenticated(page);
          const bodyText = await page.locator('body').innerText();
          if (bodyText !== bodyBeforeSubmit) {
            buyFillToastSeen ||= bodyText.includes(pageConfig.buyFilledText);
            sellFillToastSeen ||= bodyText.includes(pageConfig.sellFilledText);
          }
          if (buyFillToastSeen && sellFillToastSeen) {
            completed = true;
            break;
          }
          // Give the two post-submit fill toasts a fast path. During the first
          // five seconds, avoid switching tabs or reading order tables.
          if (Date.now() < toastOnlyDeadline) {
            await page.waitForTimeout(numberConfig(context, 'orderPollIntervalMs', 1_000, 100));
            continue;
          }
          const observed = await orderAdapter.readOrders(page);
          const recovery = postToastRecovery(observed.rows);
          if (recovery.action === 'manual-review') throw new Error(recovery.reason);
          await orderAdapter.requestCancelAllOrders(page);
          await page.waitForTimeout(POST_CANCEL_CURRENT_ORDER_RECHECK_MS);
          const afterCancellation = await orderAdapter.readOrders(page);
          const remainingSellOrderIds = afterCancellation.rows.filter(row => row.side === 'sell').map(row => row.id);
          if (remainingSellOrderIds.length > 0) throw new Error(`当前委托存在卖单（${remainingSellOrderIds.join(', ')}），请人工处理`);
          const remainingBuyOrderIds = afterCancellation.rows.filter(row => row.side === 'buy').map(row => row.id);
          if (remainingBuyOrderIds.length > 0) throw new Error(`买单撤销后仍显示当前委托（${remainingBuyOrderIds.join(', ')}）`);
          retryAfterCancellation = true;
          break;
        }
        if (retryAfterCancellation) {
          await persist({businessStatus: '买单已撤销，重新监听市场', lastError: ''});
          await context.steps.succeed('verify-result', {round, outcome: '买单已撤销，重新监听'});
          continue;
        }
        if (!completed) throw new AlphaOrderResultTimeoutError('订单生命周期在超时前未达到买卖均已成交');
        let completedHistoryBuy = undefined;
        let completedHistorySell = undefined;
        while (Date.now() < lifecycleDeadline && !context.signal.aborted) {
          const latestHistoryRows = await orderAdapter.readHistoryOrders(page, false);
          const latestHistory = findSubmittedOrders(latestHistoryRows, {token: tokenSymbol, buyPrice: order.buyPrice, sellPrice: order.sellPrice, amount, startedAt: submitStartedAt, finishedAt: submitFinishedAt});
          if (latestHistory.buy?.status === 'filled' && latestHistory.sell?.status === 'filled') {
            completedHistoryBuy = latestHistory.buy;
            completedHistorySell = latestHistory.sell;
            break;
          }
          await page.waitForTimeout(numberConfig(context, 'orderPollIntervalMs', 1_000, 100));
        }
        if (context.signal.aborted) throw new Error('任务已取消');
        if (!completedHistoryBuy || !completedHistorySell) {
          throw new AlphaOrderResultTimeoutError('买卖成交已确认，但历史委托顶部未确认本轮订单');
        }
        const buyTurnover = completedHistoryBuy.turnover;
        if (buyTurnover === undefined || buyTurnover === null || !Number.isFinite(buyTurnover)) {
          throw new Error(`历史委托未读取到买单 ${completedHistoryBuy.id} 的成交额`);
        }
        accumulatedVolume = Number((accumulatedVolume + buyTurnover).toFixed(8));
        completedSupplementalRound ||= amount < transactionAmount;
        const targetComplete = isVolumeTargetComplete({targetVolume: targetAccumulatedVolume, accumulatedVolume, completedSupplementalRound});
        await persist({completedDate: runDate, accumulatedVolume, businessStatus: targetComplete ? `${runDate}完成` : `已完成本轮，当前 ${accumulatedVolume}/${targetAccumulatedVolume}`, lastStrategy: decision.reason, lastError: ''});
        await context.steps.succeed('verify-result', {round, accumulatedVolume, targetAccumulatedVolume, buyTurnover});
      }

      await context.steps.start('write-result');
      const volume = Math.max(0, Number((accumulatedVolume - initialAccumulatedVolume).toFixed(8)));
      await persist({completedDate: runDate, accumulatedVolume, businessStatus: `${runDate}完成`, lastError: ''});
      await context.steps.succeed('write-result', {accumulatedVolume, targetAccumulatedVolume});
      completionMetrics = {volume};
      await context.notify({level: 'info', title: 'Binance Alpha 网页策略已完成', message: `${window.name} 当前实际累积交易量 ${accumulatedVolume}/${targetAccumulatedVolume}，本次新增交易量 ${volume}`});
    } catch (error) {
      terminalError = error;
      const reason = failureSummary(error);
      await persist(failureResultPatch(latestState, runDate, accumulatedVolume, reason)).catch(() => undefined);
      await context.steps.fail('write-result', reason).catch(() => undefined);
      await context.metrics.record({failedRuns: 1}, {status: 'failed'}).catch(() => undefined);
      await context.notify({level: 'error', title: 'Binance Alpha 网页策略失败', message: `${window.name}：${reason}`}).catch(() => undefined);
      throw error;
    } finally {
      let finalWear: number | null = null;
      if (shouldCaptureFinalBalance(terminalError)) {
        try {
          const finalBalance = await captureFinalBalanceAfterSettlement(
            milliseconds => page.waitForTimeout(milliseconds),
            () => captureAvailableBalance('finalBalance', () => action.readAvailableBalance(page), persist),
          );
          const recordedInitialBalance = Number(latestState.initialBalance);
          finalWear = calculateWear(Number.isFinite(recordedInitialBalance) ? recordedInitialBalance : null, finalBalance);
          if (finalWear !== null) await persist({wear: finalWear});
        } catch (error) {
          context.logger.warn('结束可用余额读取或回填失败', {message: error instanceof Error ? error.message : String(error)});
        }
      }
      if (completionMetrics) {
        await context.metrics.record({
          ...completionMetrics,
          ...(finalWear === null ? {} : {wear: finalWear}),
        }).catch(error => context.logger.warn('运行指标回填失败', {message: error instanceof Error ? error.message : String(error)}));
      }
      await session.close().catch(() => undefined);
    }
  },
});
