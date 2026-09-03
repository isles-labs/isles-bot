import type {Page} from 'playwright-core';
import {humanizePlaywrightLocator, type HumanizeOptions} from '@auto-bot/browser';
import type {OrderSide, OrderSnapshot, OrderStatus} from './order-lifecycle/types.js';

export type OrderPageAdapterConfig = {
  orderTableSelector?: string;
  positionTableSelector?: string;
  buyTabSelector?: string;
  sellTabSelector?: string;
  tokenSymbol?: string;
  cancelTimeoutMs?: number;
  pollIntervalMs?: number;
  historyLoadTimeoutMs?: number;
  humanizeOptions?: HumanizeOptions;
};

export type OrderRowEvidence = {
  id: string;
  side: OrderSide;
  status: OrderStatus;
  price: number | null;
  requestedQty: number | null;
  filledQty: number | null;
  remainingQty: number | null;
  text: string;
  createdAt?: number;
  token?: string;
  turnover?: number | null;
};

export type PostToastRecovery =
  | {action: 'cancel-buys'; buyOrderIds: string[]}
  | {action: 'manual-review'; reason: string};

const DEFAULT_ORDER_TABLE = 'div.bn-web-table-container:has(th[aria-colindex="7"])';
const DEFAULT_POSITION_TABLE = 'div.bn-web-table-container:has(th[aria-colindex="3"]):has(th:has-text("代币"))';
const HISTORY_LOAD_TIMEOUT_MS = 15_000;
const HISTORY_BUSINESS_DAY_OFFSET_MS = 9 * 60 * 60 * 1000;
const CANCEL_ALL_RETRIES = 5;

const escapeAttribute = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const numberFromText = (value: string): number | null => {
  const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const base = Number(match[0]);
  if (!Number.isFinite(base)) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('k')) return base * 1_000;
  if (normalized.includes('m')) return base * 1_000_000;
  return base;
};

// Binance history uses a UTC+9 display clock, one hour ahead of Beijing.
const historyCreatedAt = (value: string): number | undefined => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 9, Number(minute), Number(second));
};

const statusFromText = (text: string): OrderStatus => {
  if (/完全成交|已成交|filled/i.test(text)) return 'filled';
  if (/部分成交|partially.?filled|partial/i.test(text)) return 'partially-filled';
  if (/已撤销|已取消|撤单成功|canceled|cancelled/i.test(text)) return 'canceled';
  if (/拒绝|失败|rejected/i.test(text)) return 'rejected';
  if (/新订单|挂单|open|new/i.test(text)) return 'new';
  return 'unknown';
};

const sideFromText = (text: string): OrderSide | null => {
  if (/买入|buy/i.test(text)) return 'buy';
  if (/卖出|sell/i.test(text)) return 'sell';
  return null;
};

const partialQuantities = (text: string, requestedQty: number | null) => {
  const filled = text.match(/(?:已成交|成交)\s*[:：]?\s*([\d,.]+)/i);
  const remaining = text.match(/(?:剩余|未成交)\s*[:：]?\s*([\d,.]+)/i);
  const filledQty = filled ? numberFromText(filled[1]) : null;
  const remainingQty = remaining ? numberFromText(remaining[1]) : null;
  return {filledQty, remainingQty: remainingQty ?? (requestedQty !== null && filledQty !== null ? requestedQty - filledQty : null)};
};

export const parseOrderRow = (row: {id: string; cells: string[]}): OrderRowEvidence | null => {
  if (!row.id || row.cells.length < 7) return null;
  const text = row.cells.join(' ');
  const side = sideFromText(row.cells[3]);
  if (!side) return null;
  const status = statusFromText(row.cells[6]);
  const price = numberFromText(row.cells[4]);
  const requestedQty = numberFromText(row.cells[5]);
  if (status === 'partially-filled') {
    const partial = partialQuantities(text, requestedQty);
    if (partial.filledQty === null || partial.remainingQty === null) {
      return {id: row.id, side, status: 'unknown', price, requestedQty, filledQty: null, remainingQty: null, text, token: row.cells[1]};
    }
    return {id: row.id, side, status, price, requestedQty, ...partial, text, token: row.cells[1]};
  }
  if (status === 'filled') return {id: row.id, side, status, price, requestedQty, filledQty: requestedQty, remainingQty: 0, text, token: row.cells[1]};
  if (status === 'new') return {id: row.id, side, status, price, requestedQty, filledQty: 0, remainingQty: requestedQty, text, token: row.cells[1]};
  return {id: row.id, side, status, price, requestedQty, filledQty: 0, remainingQty: requestedQty, text, token: row.cells[1]};
};

export const findSubmittedOrders = (rows: OrderRowEvidence[], input: {token: string; buyPrice: number; sellPrice: number; amount: number; startedAt: number; finishedAt: number}) => {
  const token = input.token.trim().toUpperCase();
  const lowerBound = input.startedAt - 15_000;
  const upperBound = input.finishedAt + 60_000;
  const matches = (row: OrderRowEvidence, side: OrderSide, price: number) => {
    if (row.side !== side || row.price === null || Math.abs(row.price - price) / price > 0.0002) return false;
    if (token && row.token?.trim().toUpperCase() !== token) return false;
    if (row.createdAt !== undefined && (row.createdAt < lowerBound || row.createdAt > upperBound)) return false;
    const turnover = row.requestedQty === null ? null : row.requestedQty * row.price;
    return turnover === null || Math.abs(turnover - input.amount) / input.amount <= 0.03;
  };
  return {buy: rows.find(row => matches(row, 'buy', input.buyPrice)), sell: rows.find(row => matches(row, 'sell', input.sellPrice))};
};

export const findIncompleteCurrentMarketOrderIds = (rows: readonly OrderRowEvidence[], tokenSymbol: string): string[] => {
  const token = tokenSymbol.trim().toUpperCase();
  return rows
    .filter(row => row.token?.trim().toUpperCase() === token && ['new', 'partially-filled', 'unknown'].includes(row.status))
    .map(row => row.id);
};

export const postToastRecovery = (rows: readonly OrderRowEvidence[]): PostToastRecovery => {
  const sellOrderIds = rows.filter(row => row.side === 'sell').map(row => row.id);
  if (sellOrderIds.length > 0) {
    return {action: 'manual-review', reason: `当前委托存在卖单（${sellOrderIds.join(', ')}），请人工处理`};
  }
  const buyOrderIds = rows.filter(row => row.side === 'buy').map(row => row.id);
  if (buyOrderIds.length === 0) {
    return {action: 'manual-review', reason: '未命中买卖成交提示，且当前委托未读取到买单；无法确认订单结果，请人工检查'};
  }
  return {action: 'cancel-buys', buyOrderIds};
};

export const parseHistoryOrderRow = (row: {id: string; cells: string[]}): OrderRowEvidence | null => {
  if (!row.id || row.cells.length < 13) return null;
  const text = row.cells.join(' ');
  const createdAt = historyCreatedAt(row.cells[0]);
  const side = sideFromText(row.cells[3]);
  if (!side) return null;
  const status = statusFromText(row.cells[12]);
  const price = numberFromText(row.cells[5]);
  const requestedQty = numberFromText(row.cells[7]);
  const filledQty = numberFromText(row.cells[6]);
  const turnover = numberFromText(row.cells[8]);
  if (status === 'partially-filled' && (filledQty === null || requestedQty === null)) {
    return {id: row.id, side, status: 'unknown', price, requestedQty, filledQty: null, remainingQty: null, text, createdAt, token: row.cells[1], turnover};
  }
  const safeRequested = requestedQty ?? 0;
  const safeFilled = status === 'filled' ? (filledQty ?? safeRequested) : (filledQty ?? 0);
  return {id: row.id, side, status, price, requestedQty: safeRequested, filledQty: safeFilled, remainingQty: Math.max(0, safeRequested - safeFilled), text, createdAt, token: row.cells[1], turnover};
};

const beijingDate = (timestamp: number): string => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(timestamp));

/** The trading day rolls at 09:00 Beijing time. */
export const historyBusinessDate = (now = new Date()): string => beijingDate(now.getTime() - HISTORY_BUSINESS_DAY_OFFSET_MS);

/** True when a newest-to-oldest history scan has reached a prior business day. */
export const hasReachedEarlierHistoryBusinessDate = (rows: readonly OrderRowEvidence[], date: string): boolean =>
  rows.some(row => row.createdAt !== undefined && historyBusinessDate(new Date(row.createdAt)) < date);

export type CurrentMarketVolumeSummary = {
  completedBuyOrderIds: string[];
  accumulatedVolume: number;
  buyTurnover: number;
  sellTurnover: number;
  unreadableCompletedBuyOrderIds: string[];
  unpairedBuyOrderIds: string[];
};

/** Summarizes completed current-market rounds without treating sell turnover as volume. */
export const summarizeCurrentMarketVolume = (
  rows: readonly OrderRowEvidence[],
  date: string,
  tokenSymbol: string,
): CurrentMarketVolumeSummary => {
  const token = tokenSymbol.trim().toUpperCase();
  const summary: CurrentMarketVolumeSummary = {
    completedBuyOrderIds: [], accumulatedVolume: 0,
    buyTurnover: 0, sellTurnover: 0,
    unreadableCompletedBuyOrderIds: [], unpairedBuyOrderIds: [],
  };
  if (!token) return summary;

  const currentMarketRows = rows
    .filter(row => row.status === 'filled'
      && row.createdAt !== undefined
      && historyBusinessDate(new Date(row.createdAt)) === date
      && row.token?.trim().toUpperCase() === token)
    .sort((left, right) => {
      const timestampDifference = (left.createdAt ?? 0) - (right.createdAt ?? 0);
      if (timestampDifference !== 0) return timestampDifference;
      const leftOrderId = Number(left.id);
      const rightOrderId = Number(right.id);
      if (Number.isSafeInteger(leftOrderId) && Number.isSafeInteger(rightOrderId)) return leftOrderId - rightOrderId;
      return left.id.localeCompare(right.id);
    });
  const unpairedBuys: OrderRowEvidence[] = [];

  for (const row of currentMarketRows) {
    if (row.side === 'buy') {
      unpairedBuys.push(row);
      continue;
    }
    const buy = unpairedBuys.shift();
    if (!buy) continue;
    summary.completedBuyOrderIds.push(buy.id);
    if (buy.turnover === null || buy.turnover === undefined) summary.unreadableCompletedBuyOrderIds.push(buy.id);
    else summary.buyTurnover += buy.turnover;
    summary.sellTurnover += row.turnover ?? 0;
  }

  summary.unpairedBuyOrderIds = unpairedBuys.map(row => row.id);
  summary.accumulatedVolume = Number(summary.buyTurnover.toFixed(8));
  summary.buyTurnover = summary.accumulatedVolume;
  summary.sellTurnover = Number(summary.sellTurnover.toFixed(8));
  return summary;
};

const toSnapshot = (row: OrderRowEvidence): OrderSnapshot | null => {
  if (row.status === 'unknown' || row.requestedQty === null || row.filledQty === null || row.remainingQty === null) return null;
  return {
    id: row.id,
    side: row.side,
    status: row.status,
    requestedQty: row.requestedQty,
    filledQty: row.filledQty,
    remainingQty: Math.max(0, row.remainingQty),
    ...(row.price === null ? {} : {price: row.price}),
  };
};

export class BinanceAlphaOrderPageAdapter {
  private readonly config: Required<OrderPageAdapterConfig>;

  constructor(config: OrderPageAdapterConfig = {}) {
    this.config = {
      orderTableSelector: DEFAULT_ORDER_TABLE,
      positionTableSelector: DEFAULT_POSITION_TABLE,
      buyTabSelector: '[role="tab"]:has-text("买入")',
      sellTabSelector: '[role="tab"]:has-text("卖出")',
      tokenSymbol: '',
      cancelTimeoutMs: 10_000,
      pollIntervalMs: 500,
      historyLoadTimeoutMs: HISTORY_LOAD_TIMEOUT_MS,
      humanizeOptions: {},
      ...config,
    };
  }

  private interactive(page: Page, locator: ReturnType<Page['locator']>): ReturnType<Page['locator']> {
    return Object.keys(this.config.humanizeOptions).length
      ? humanizePlaywrightLocator(locator, page, this.config.humanizeOptions)
      : locator;
  }

  private currentOrderRowsSelector(): string {
    return `#bn-tab-pane-orderOrder ${this.config.orderTableSelector} tr[role="row"][data-row-key]`;
  }

  async readOrders(page: Page): Promise<{buy?: OrderSnapshot; sell?: OrderSnapshot; rows: OrderRowEvidence[]}> {
    await this.switchOrderTab(page, 'current');
    const rows = await page.locator(this.currentOrderRowsSelector()).evaluateAll(elements => elements.map(element => ({
      id: element.getAttribute('data-row-key') || '',
      cells: Array.from(element.querySelectorAll<HTMLElement>('td[role="cell"]')).map(cell => (cell.innerText || cell.textContent || '').trim()),
    })));
    const evidence = rows.map(parseOrderRow).filter((row): row is OrderRowEvidence => row !== null);
    const buy = evidence.find(row => row.side === 'buy');
    const sell = evidence.find(row => row.side === 'sell');
    return {rows: evidence, buy: buy ? toSnapshot(buy) ?? undefined : undefined, sell: sell ? toSnapshot(sell) ?? undefined : undefined};
  }

  async switchOrderTab(page: Page, tab: 'current' | 'history'): Promise<void> {
    const selector = tab === 'current' ? '#bn-tab-orderOrder' : '#bn-tab-orderHistory';
    const panel = tab === 'current' ? '#bn-tab-pane-orderOrder' : '#bn-tab-pane-orderHistory';
    await this.interactive(page, page.locator(selector).first()).click({timeout: this.config.cancelTimeoutMs});
    await page.locator(`${selector}[aria-selected="true"]`).waitFor({state: 'attached', timeout: this.config.cancelTimeoutMs});
    await page.locator(panel).first().waitFor({state: 'attached', timeout: this.config.cancelTimeoutMs});
    if (tab === 'history') {
      const oneWeekRange = page.locator(`${panel} div.bn-flex`).filter({hasText: /^1周$/}).first();
      await this.interactive(page, oneWeekRange).click({timeout: this.config.cancelTimeoutMs});
    }
  }

  private async refreshHistoryLimitTab(page: Page): Promise<void> {
    // Binance keeps the previous virtualized position when changing the main
    // order tab. Re-selecting these two history sub-tabs refreshes the Limit
    // list and puts the newest orders back at the top without scrolling.
    const historyPanelSelector = '#bn-tab-pane-orderHistory';
    const stopLossTab = page.locator(`${historyPanelSelector} #bn-tab-1`).first();
    const limitTab = page.locator(`${historyPanelSelector} #bn-tab-0`).first();
    await this.interactive(page, stopLossTab).click({timeout: this.config.cancelTimeoutMs});
    await page.locator(`${historyPanelSelector} #bn-tab-1[aria-selected="true"]`).first().waitFor({state: 'visible', timeout: this.config.cancelTimeoutMs});
    await this.interactive(page, limitTab).click({timeout: this.config.cancelTimeoutMs});
    await page.locator(`${historyPanelSelector} #bn-tab-0[aria-selected="true"]`).first().waitFor({state: 'visible', timeout: this.config.cancelTimeoutMs});
  }

  async readHistoryOrders(page: Page, scanAll = true): Promise<OrderRowEvidence[]> {
    await this.switchOrderTab(page, 'history');
    await this.refreshHistoryLimitTab(page);
    const seen = new Map<string, {id: string; cells: string[]}>();
    // History and current-order tables do not reliably share the same header
    // structure. Scope directly to the selected History tab instead of
    // reusing the configurable current-order table selector.
    const rowSelector = '#bn-tab-pane-orderHistory tr[role="row"][data-row-key]';
    const readVisibleRows = () => page.locator(rowSelector).evaluateAll(elements => elements.map(element => ({
      id: element.getAttribute('data-row-key') || '',
      cells: Array.from(element.querySelectorAll<HTMLElement>('td[role="cell"]')).map(cell => (cell.innerText || cell.textContent || '').trim()),
    })));
    const historyPanel = page.locator('#bn-tab-pane-orderHistory').first();
    const loadDeadline = Date.now() + this.config.historyLoadTimeoutMs;
    while (Date.now() <= loadDeadline) {
      if (await page.locator(rowSelector).count()) break;
      const panelText = await historyPanel.innerText().catch(() => '');
      if (/暂无数据|没有数据|无数据/.test(panelText)) return [];
      await page.waitForTimeout(this.config.pollIntervalMs);
    }
    if (!(await page.locator(rowSelector).count())) {
      throw new Error(`历史委托列表在 ${this.config.historyLoadTimeoutMs / 1000} 秒内未加载；未回填当前实际累积交易量，请确认页面已打开“历史委托”并检查网络后重试`);
    }
    const body = historyPanel.locator('.bn-web-table-body').first();
    if (scanAll && await body.count()) {
      await body.evaluate(element => { element.scrollTop = 0; });
      await page.waitForTimeout(this.config.pollIntervalMs);
    }
    const rows = await readVisibleRows();
    if (!scanAll) return rows.map(parseHistoryOrderRow).filter((row): row is OrderRowEvidence => row !== null);
    for (const row of rows) if (row.id) seen.set(row.id, row);
    const businessDate = historyBusinessDate();
    // The initial virtualized viewport can include boundary rows. Only end the
    // scan after a scroll reveals an earlier business day.
    let reachedEarlierBusinessDate = false;
    let currentVisibleRows = rows;
    const hasNewVisibleRows = (candidateRows: typeof rows, knownIds: Set<string>) =>
      candidateRows.some(row => row.id && !knownIds.has(row.id));
    const waitForNewVisibleRows = async (knownIds: Set<string>) => {
      let candidateRows = await readVisibleRows();
      const loadDeadline = Date.now() + this.config.historyLoadTimeoutMs;
      while (Date.now() <= loadDeadline && !hasNewVisibleRows(candidateRows, knownIds)) {
        await page.waitForTimeout(this.config.pollIntervalMs);
        candidateRows = await readVisibleRows();
      }
      return candidateRows;
    };
    const collectVisibleRows = (nextRows: typeof rows) => {
      for (const row of nextRows) if (row.id) seen.set(row.id, row);
      currentVisibleRows = nextRows;
      const nextEvidence = nextRows.map(parseHistoryOrderRow).filter((row): row is OrderRowEvidence => row !== null);
      reachedEarlierBusinessDate = hasReachedEarlierHistoryBusinessDate(nextEvidence, businessDate);
    };
    while (await body.count() && !reachedEarlierBusinessDate) {
      const scroll = await body.evaluate(element => ({top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight}));
      const visibleIds = new Set(currentVisibleRows.map(row => row.id).filter(Boolean));
      if (scroll.top + scroll.client >= scroll.height - 2) {
        const nextRows = await waitForNewVisibleRows(visibleIds);
        if (!hasNewVisibleRows(nextRows, visibleIds)) break;
        collectVisibleRows(nextRows);
        continue;
      }
      await body.evaluate(element => { element.scrollTop += element.clientHeight * 0.8; });
      await page.waitForTimeout(this.config.pollIntervalMs);
      let nextRows = await readVisibleRows();
      let nextScroll = await body.evaluate(element => ({top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight}));
      if (!hasNewVisibleRows(nextRows, visibleIds) && (nextScroll.top + nextScroll.client >= nextScroll.height - 2 || nextScroll.top <= scroll.top)) {
        nextRows = await waitForNewVisibleRows(visibleIds);
        nextScroll = await body.evaluate(element => ({top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight}));
      }
      if (hasNewVisibleRows(nextRows, visibleIds)) {
        collectVisibleRows(nextRows);
        continue;
      }
      if (nextScroll.top <= scroll.top) break;
    }
    return Array.from(seen.values()).map(parseHistoryOrderRow).filter((row): row is OrderRowEvidence => row !== null);
  }

  async cancelOrder(page: Page, orderId: string): Promise<void> {
    const row = page.locator(`${this.currentOrderRowsSelector()}[data-row-key="${escapeAttribute(orderId)}"]`).first();
    await row.waitFor({state: 'visible', timeout: this.config.cancelTimeoutMs});
    const cancelIcon = row.locator('td[aria-colindex="11"] svg').first();
    await this.interactive(page, cancelIcon).click({timeout: this.config.cancelTimeoutMs});
    const deadline = Date.now() + this.config.cancelTimeoutMs;
    while (Date.now() <= deadline) {
      if (!(await row.isVisible().catch(() => false))) return;
      const status = await row.locator('td[aria-colindex="7"]').innerText().catch(() => '');
      if (statusFromText(status) === 'canceled') return;
      await page.waitForTimeout(this.config.pollIntervalMs);
    }
    throw new Error(`订单 ${orderId} 点击撤单后未确认状态变化`);
  }

  async requestCancelAllOrders(page: Page): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= CANCEL_ALL_RETRIES; attempt += 1) {
      try {
        const cancelAll = page.locator('#bn-tab-pane-orderOrder thead th[aria-colindex="11"] div.text-TextLink.cursor-pointer').filter({hasText: /^全部取消$/}).first();
        await cancelAll.waitFor({state: 'visible', timeout: this.config.cancelTimeoutMs});
        await this.interactive(page, cancelAll).click({timeout: this.config.cancelTimeoutMs});

        const confirm = page.locator('div.bn-modal-confirm button.bn-button.bn-button__primary.data-size-middle').filter({hasText: /^确认$/}).first();
        await confirm.waitFor({state: 'visible', timeout: this.config.cancelTimeoutMs});
        await this.interactive(page, confirm).click({timeout: this.config.cancelTimeoutMs});
        return;
      } catch (error) {
        lastError = error;
        if (attempt < CANCEL_ALL_RETRIES) await page.waitForTimeout(this.config.pollIntervalMs);
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`全部取消连续 ${CANCEL_ALL_RETRIES} 次未成功：${reason}`);
  }

  async switchSide(page: Page, side: OrderSide): Promise<void> {
    await this.interactive(page, page.locator(side === 'buy' ? this.config.buyTabSelector : this.config.sellTabSelector).first()).click();
  }

  async readPosition(page: Page): Promise<number | null> {
    const symbol = this.config.tokenSymbol.trim();
    if (!symbol) return null;
    const rows = page.locator(`${this.config.positionTableSelector} tr[role="row"]`).filter({hasText: symbol});
    const row = rows.first();
    if (!(await row.count())) return null;
    const cells = await row.locator('td[role="cell"]').allInnerTexts();
    return numberFromText(cells[2] || '');
  }
}
