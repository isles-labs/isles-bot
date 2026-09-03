import type {Locator, Page} from 'playwright-core';
import {humanizePlaywrightLocator, type HumanizeOptions} from '@auto-bot/browser';
import type {ObservedTrade} from './strategy.js';

export type AlphaPageConfig = {
  tradeTabSelector: string;
  tradePanelSelector: string;
  tradeListSelector: string;
  orderFormSelector: string;
  limitPriceSelector: string;
  reverseSellPriceSelector: string;
  turnoverSelector: string;
  buyButtonSelector: string;
  sellButtonSelector: string;
  buyTabSelector: string;
  sellTabSelector: string;
  sellQuantitySelector: string;
  reverseOrderText: string;
  confirmButtonText: string;
  buyFilledText: string;
  sellFilledText: string;
  confirmButtonTimeoutMs: number;
  formControlTimeoutMs: number;
  balanceSelector: string;
  balanceText: string;
  balanceAssetSymbol: string;
  balanceReadTimeoutMs: number;
  requireBalanceCheck: boolean;
  pollIntervalMs: number;
  orderResultTimeoutMs: number;
  toastOnlyWindowMs: number;
  orderSubmitRetries: number;
  buyPriceOffsetBps: number;
  sellPriceOffsetBps: number;
  autoConfirm: boolean;
  enableWebSocketFeed: boolean;
  securityVerificationSelector: string;
  navigationRetryTimeoutMs: number;
};

export class AlphaPageStateError extends Error {}
export class AlphaOrderResultTimeoutError extends Error {}
export class AlphaLoginRequiredError extends AlphaPageStateError {
  constructor() { super('当前账户需要重新登录'); }
}

const parseNumber = (value: string) => {
  const normalized = value.replace(/,/g, '').trim();
  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) return Number.NaN;
  const multiplier = /k$/i.test(normalized) ? 1_000 : 1;
  return Number(match[0]) * multiplier;
};

export const parseAvailableBalance = (text: string, balanceText: string, assetSymbol: string): number | null => {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const balanceLabel = escape(balanceText.trim());
  const asset = escape(assetSymbol.trim());
  if (!balanceLabel || !asset) return null;
  const match = text.match(new RegExp(`${balanceLabel}\\s*([\\d,.]+)\\s*${asset}(?:\\s|$)`, 'i'))
    || text.match(new RegExp(`([\\d,.]+)\\s*${asset}(?:\\s|$)[\\s\\S]{0,80}${balanceLabel}`, 'i'));
  const value = match?.[1] ? parseNumber(match[1]) : Number.NaN;
  return Number.isFinite(value) ? value : null;
};

export const selectAvailableBalance = (texts: readonly string[], balanceText: string, assetSymbol: string): number | null => {
  const balances = texts
    .map(text => parseAvailableBalance(text, balanceText, assetSymbol))
    .filter((balance): balance is number => balance !== null);
  return balances.find(balance => balance > 0) ?? balances[0] ?? null;
};

export const parseTradeRow = (cells: readonly string[], className = '', rowText = ''): Omit<ObservedTrade, 'timestamp'> | null => {
  if (cells.length < 3) return null;
  const price = parseNumber(cells[1]);
  const quantity = parseNumber(cells[2]);
  if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) return null;
  const side: 'buy' | 'sell' = /sell|ask|red|var\(--color-sell\)/i.test(`${rowText} ${className}`) ? 'sell' : 'buy';
  return {price, quantity, side};
};

// Use a raw browser expression instead of a TypeScript function. Script Center's
// The Node runtime can add naming helpers when serializing page functions.
const latestTradePageExpression = (rootSelector: string) => String.raw`(() => {
  const rootSelector = ${JSON.stringify(rootSelector)};
  const containers = Array.from(document.querySelectorAll(rootSelector)).filter(node => {
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  });
  for (const container of containers) {
    for (const row of Array.from(container.children)) {
      const cells = Array.from(row.children).map(node => (node.textContent || '').trim());
      if (cells.length < 3) continue;
      const parse = value => {
        const normalized = value.replace(/,/g, '').trim();
        const match = normalized.match(/\d+(?:\.\d+)?/);
        return match ? Number(match[0]) * (/k$/i.test(normalized) ? 1000 : 1) : Number.NaN;
      };
      const price = parse(cells[1]);
      const quantity = parse(cells[2]);
      if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) continue;
      const text = (row.textContent || '') + ' ' + (row.outerHTML || '');
      return {price, quantity, side: /sell|ask|red|var\(--color-sell\)/i.test(text) ? 'sell' : 'buy'};
    }
  }
  return null;
})()`;

const installWebSocketTradeFeed = () => {
  const queueKey = '__autoBotBinanceAlphaWsMessages';
  if (Array.isArray((window as unknown as Record<string, unknown>)[queueKey])) return;
  const messages: Array<{data: string; at: number}> = [];
  const NativeWebSocket = window.WebSocket;
  function capture(data: unknown) {
    if (typeof data !== 'string') return;
    messages.push({data, at: Date.now()});
    if (messages.length > 500) messages.splice(0, messages.length - 500);
  }
  function HookedWebSocket(url: string | URL, protocols?: string | string[]) {
    const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    socket.addEventListener('message', event => capture(event.data));
    return socket;
  }
  HookedWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(HookedWebSocket, NativeWebSocket);
  window.WebSocket = HookedWebSocket as unknown as typeof WebSocket;
  (window as unknown as Record<string, unknown>)[queueKey] = messages;
};

const webSocketTradePageExpression = String.raw`(() => {
  const messages = window.__autoBotBinanceAlphaWsMessages;
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message.data !== 'string') continue;
    let payload;
    try { payload = JSON.parse(message.data); } catch { continue; }
    const candidates = [];
    const pending = [payload];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object') continue;
      if (Array.isArray(value)) { pending.push(...value); continue; }
      candidates.push(value);
      pending.push(...Object.values(value));
    }
    for (let candidateIndex = candidates.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = candidates[candidateIndex];
      const priceText = candidate.p ?? candidate.price ?? candidate.lastPrice ?? candidate.tradePrice;
      const quantityText = candidate.q ?? candidate.qty ?? candidate.quantity ?? candidate.amount ?? candidate.baseQty;
      const price = typeof priceText === 'number' ? priceText : Number(String(priceText || '').replace(/,/g, ''));
      const quantity = typeof quantityText === 'number' ? quantityText : Number(String(quantityText || '').replace(/,/g, ''));
      if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) continue;
      const signal = String(candidate.S ?? candidate.side ?? candidate.direction ?? candidate.type ?? '');
      return {price, quantity, side: /sell|ask|red/i.test(signal) || candidate.m === true ? 'sell' : 'buy', timestamp: Number(message.at) || Date.now()};
    }
  }
  return null;
})()`;

const formatPrice = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) throw new AlphaPageStateError('计算出的限价无效');
  return value.toFixed(12).replace(/\.?(0+)$/, '');
};

const isTransientNavigationError = (error: unknown) => /ERR_CONNECTION_(?:CLOSED|RESET)|ERR_CONNECTION_REFUSED|ERR_TIMED_OUT/i.test(error instanceof Error ? error.message : String(error));

export async function gotoWithTransientRetry(page: Page, url: string, options: {timeoutMs: number; retryWindowMs: number; retryIntervalMs: number}) {
  const deadline = Date.now() + Math.max(0, options.retryWindowMs);
  while (true) {
    try {
      await page.goto(url, {waitUntil: 'domcontentloaded', timeout: options.timeoutMs});
      return;
    } catch (error) {
      if (!isTransientNavigationError(error) || Date.now() >= deadline) throw error;
      await page.waitForTimeout(Math.min(Math.max(100, options.retryIntervalMs), Math.max(100, deadline - Date.now())));
    }
  }
}

/** Browser operations are deliberately isolated from strategy and runtime state. */
export class BinanceAlphaWebAction {
  private latestTradeSource: 'websocket' | 'dom' | null = null;

  constructor(
    private readonly config: AlphaPageConfig,
    private readonly log: (message: string, details?: Record<string, unknown>) => void,
    private readonly humanizeOptions?: HumanizeOptions,
  ) {}

  private interactive(page: Page, locator: Locator): Locator {
    return this.humanizeOptions ? humanizePlaywrightLocator(locator, page, this.humanizeOptions) : locator;
  }

  async assertAuthenticated(page: Page) {
    const verification = page.locator(this.config.securityVerificationSelector).first();
    if (await verification.isVisible().catch(() => false)) {
      this.log('检测到 Binance Alpha 安全验证页面，当前账户需要重新登录');
      throw new AlphaLoginRequiredError();
    }
    const loginButton = page.locator('button.bn-button.bn-button__secondary.data-size-small')
      .filter({hasText: /^登录$/})
      .first();
    if (await loginButton.isVisible().catch(() => false)) {
      this.log('检测到 Binance Alpha 登录按钮，当前账户需要重新登录');
      throw new AlphaLoginRequiredError();
    }
    const verificationModal = page.locator('div.bn-modal-confirm-title')
      .filter({hasText: /^需要验证$/})
      .first();
    if (await verificationModal.isVisible().catch(() => false)) {
      this.log('检测到 Binance Alpha “需要验证”弹窗，当前账户需要重新登录');
      throw new AlphaLoginRequiredError();
    }
  }

  async openMarket(page: Page, marketUrl: string) {
    if (!/^https:\/\/www\.binance\.com\//.test(marketUrl)) throw new AlphaPageStateError('市场地址必须是 https://www.binance.com/ 下的页面');
    if (this.config.enableWebSocketFeed) await page.addInitScript(installWebSocketTradeFeed);
    await gotoWithTransientRetry(page, marketUrl, {
      timeoutMs: 60_000,
      retryWindowMs: this.config.navigationRetryTimeoutMs,
      retryIntervalMs: this.config.pollIntervalMs,
    });
    await this.assertAuthenticated(page);
    await page.locator(this.config.orderFormSelector).first().waitFor({state: 'visible', timeout: 60_000});
    const tradeTab = page.locator(this.config.tradeTabSelector).first();
    await tradeTab.waitFor({state: 'visible', timeout: 60_000});
    if ((await tradeTab.getAttribute('aria-selected')) !== 'true') await this.interactive(page, tradeTab).click();
    // Binance keeps the active tab panel at zero layout size; its child list,
    // not the panel wrapper, is the visible element we need to wait for.
    await page.locator(this.config.tradePanelSelector).first().waitFor({state: 'attached', timeout: 15_000});
    const tradeLists = await page.locator(this.config.tradeListSelector).all().catch(() => []);
    const hasVisibleTradeList = (await Promise.all(tradeLists.map(tradeList => tradeList.isVisible().catch(() => false)))).some(Boolean);
    if (!hasVisibleTradeList) {
      this.log('成交记录 DOM 列表不可见，将使用页面 WebSocket 行情作为数据源', {tradeListSelector: this.config.tradeListSelector});
    }
  }

  async readLatestTrade(page: Page): Promise<ObservedTrade | null> {
    await this.assertAuthenticated(page);
    if (this.config.enableWebSocketFeed) {
      const trade = await page.evaluate(webSocketTradePageExpression) as ObservedTrade | null;
      if (trade) {
        this.logLatestTradeSource('websocket');
        return trade;
      }
    }
    const trade = await page.evaluate(latestTradePageExpression(this.config.tradeListSelector)) as Omit<ObservedTrade, 'timestamp'> | null;
    if (!trade) return null;
    this.logLatestTradeSource('dom');
    return {...trade, timestamp: Date.now()};
  }

  private logLatestTradeSource(source: 'websocket' | 'dom') {
    if (this.latestTradeSource === source) return;
    this.latestTradeSource = source;
    this.log(`当前成交行情数据源：${source === 'websocket' ? 'WebSocket' : 'DOM'}`, {source});
  }

  async readAvailableBalance(page: Page): Promise<number | null> {
    await this.assertAuthenticated(page);
    const deadline = Date.now() + this.config.balanceReadTimeoutMs;
    const sources = [this.config.balanceSelector, this.config.orderFormSelector];
    let zeroBalanceSource: string | null = null;
    while (Date.now() <= deadline) {
      await this.assertAuthenticated(page);
      for (const selector of sources) {
        const locator = page.locator(selector);
        const nodes = await locator.all().catch(() => []);
        const texts: string[] = [];
        for (const node of nodes) {
          if (await node.isVisible().catch(() => false)) texts.push(await node.innerText().catch(() => ''));
        }
        const balance = selectAvailableBalance(texts, this.config.balanceText, this.config.balanceAssetSymbol);
        if (balance !== null) {
          if (balance > 0) {
            await this.assertAuthenticated(page);
            this.log('已读取页面可用余额', {asset: this.config.balanceAssetSymbol, balance, sourceSelector: selector});
            return balance;
          }
          zeroBalanceSource = selector;
        }
      }
      if (Date.now() < deadline) await page.waitForTimeout(Math.min(this.config.pollIntervalMs, 500));
    }
    if (zeroBalanceSource) this.log('页面可用余额等待结束后仍为零', {asset: this.config.balanceAssetSymbol, sourceSelector: zeroBalanceSource});
    if (zeroBalanceSource) {
      await this.assertAuthenticated(page);
      return 0;
    }
    return null;
  }

  async submitReverseOrder(page: Page, input: {price: number; amount: number}) {
    await this.assertAuthenticated(page);
    const buyPrice = input.price * (1 + this.config.buyPriceOffsetBps / 10_000);
    const sellPrice = input.price * (1 - this.config.sellPriceOffsetBps / 10_000);
    const form = page.locator(this.config.orderFormSelector).first();
    await this.fillVisibleEditable(page, form, this.config.limitPriceSelector, formatPrice(buyPrice), '限价买入价格');
    await this.enableReverseOrder(page, form);
    await this.fillVisibleEditable(page, form, this.config.reverseSellPriceSelector, formatPrice(sellPrice), '反向限价卖出价格');
    await this.fillVisibleEditable(page, form, this.config.turnoverSelector, String(input.amount), '成交额');
    const bodyBeforeSubmit = await page.locator('body').innerText();
    let submitted = false;
    for (let attempt = 1; attempt <= this.config.orderSubmitRetries; attempt += 1) {
      try {
        await this.interactive(page, form.locator(this.config.buyButtonSelector).first()).click({timeout: 10_000});
        submitted = true;
        break;
      } catch (error) {
        this.log('Binance Alpha 买入按钮点击失败，准备重试', {attempt, message: error instanceof Error ? error.message : String(error)});
        await page.waitForTimeout(this.config.pollIntervalMs);
      }
    }
    if (!submitted) throw new AlphaPageStateError(`买入按钮连续 ${this.config.orderSubmitRetries} 次点击失败`);

    if (this.config.autoConfirm) await this.waitAndClickConfirmation(page);
    return {buyPrice, sellPrice, bodyBeforeSubmit};
  }

  private async enableReverseOrder(page: Page, form: Locator) {
    const label = form.getByText(this.config.reverseOrderText, {exact: true}).first();
    const deadline = Date.now() + this.config.formControlTimeoutMs;
    let clicked = false;

    while (Date.now() <= deadline) {
      if (!(await label.isVisible().catch(() => false))) {
        if (Date.now() < deadline) await page.waitForTimeout(Math.min(this.config.pollIntervalMs, 500));
        continue;
      }

      // Binance uses a sibling `div[role="checkbox"]` for this control rather
      // than a native input. Find it through the nearest ancestor containing
      // the checkbox, then wait for its ARIA state to confirm the click.
      const semanticCheckbox = label
        .locator('xpath=ancestor::*[.//*[@role="checkbox"]][1]')
        .locator('[role="checkbox"]')
        .first();
      if (await semanticCheckbox.count() && await semanticCheckbox.isVisible().catch(() => false)) {
        if ((await semanticCheckbox.getAttribute('aria-checked')) === 'true') {
          this.log('反向订单开关已开启', {control: 'role=checkbox', reverseOrderText: this.config.reverseOrderText});
          return;
        }
        if (!clicked) {
          await this.interactive(page, semanticCheckbox).click({timeout: 10_000});
          clicked = true;
          this.log('已开启反向订单开关', {control: 'role=checkbox', reverseOrderText: this.config.reverseOrderText});
        }
      } else {
        // Keep compatibility with older Binance markup that used a native
        // checkbox associated with a label.
        const nativeCheckbox = label
          .locator('xpath=ancestor::*[.//input[@type="checkbox"]][1]')
          .locator('input[type="checkbox"]')
          .first();
        if (await nativeCheckbox.count()) {
          if (await nativeCheckbox.isChecked().catch(() => false)) {
            this.log('反向订单开关已开启', {control: 'input[type="checkbox"]', reverseOrderText: this.config.reverseOrderText});
            return;
          }
          await this.interactive(page, nativeCheckbox).click({force: true});
          this.log('已开启反向订单开关', {control: 'input[type="checkbox"]', reverseOrderText: this.config.reverseOrderText});
          return;
        }
        if (!clicked) {
          await this.interactive(page, label).click({timeout: 10_000});
          clicked = true;
        }
      }

      if (Date.now() < deadline) await page.waitForTimeout(Math.min(this.config.pollIntervalMs, 500));
    }

    throw new AlphaPageStateError(`未能开启“${this.config.reverseOrderText}”开关；请确认订单表单中存在可操作的反向订单复选框`);
  }

  async submitSellOrder(page: Page, input: {price: number; quantity: number}) {
    await this.assertAuthenticated(page);
    const form = page.locator(this.config.orderFormSelector).first();
    const sellTab = page.locator(this.config.sellTabSelector).first();
    if (await sellTab.count()) await this.interactive(page, sellTab).click({timeout: 10_000});
    await this.fillVisibleEditable(page, form, this.config.limitPriceSelector, formatPrice(input.price), '限价卖出价格');
    await this.fillVisibleEditable(page, form, this.config.sellQuantitySelector, String(input.quantity), '卖出数量');
    const buttons = await form.locator(this.config.sellButtonSelector).all();
    let button: Locator | undefined;
    for (const candidate of buttons) {
      if (await candidate.isVisible().catch(() => false) && await candidate.isEnabled().catch(() => false)) { button = candidate; break; }
    }
    if (!button) throw new AlphaPageStateError('未找到可见的卖出提交按钮');
    await this.interactive(page, button).click({timeout: 10_000});
    if (this.config.autoConfirm) await this.waitAndClickConfirmation(page);
  }

  private async fillVisibleEditable(page: Page, container: Locator, selector: string, value: string, fieldName: string) {
    const deadline = Date.now() + this.config.formControlTimeoutMs;
    let visibleCandidates = 0;
    while (Date.now() <= deadline) {
      const candidates = await container.locator(selector).all().catch(() => []);
      for (const candidate of candidates) {
        if (!(await candidate.isVisible().catch(() => false))) continue;
        visibleCandidates += 1;
        if (!(await candidate.isEnabled().catch(() => false)) || !(await candidate.isEditable().catch(() => false))) continue;
        await this.interactive(page, candidate).fill(value, {timeout: 10_000});
        this.log('已填写下单字段', {fieldName, selector});
        return;
      }
      if (Date.now() < deadline) await page.waitForTimeout(Math.min(this.config.pollIntervalMs, 500));
    }
    throw new AlphaPageStateError(`未找到可填写的${fieldName}输入框；选择器“${selector}”命中可见元素 ${visibleCandidates} 次，请检查页面布局或调整该选择器`);
  }

  private async waitAndClickConfirmation(page: Page) {
    const deadline = Date.now() + this.config.confirmButtonTimeoutMs;
    let visibleCandidates = 0;
    while (Date.now() <= deadline) {
      const candidates = await page.getByRole('button', {name: this.config.confirmButtonText, exact: true}).all();
      for (const candidate of candidates) {
        if (!(await candidate.isVisible().catch(() => false))) continue;
        visibleCandidates += 1;
        if (!(await candidate.isEnabled().catch(() => false))) continue;
        // Order confirmation is time-sensitive. Once the configured button is
        // visible and enabled, do not add behavioral delay before submitting it.
        await candidate.click({timeout: 10_000});
        this.log('已快速点击网页确认按钮', {confirmButtonText: this.config.confirmButtonText});
        return;
      }
      if (Date.now() < deadline) await page.waitForTimeout(Math.min(this.config.pollIntervalMs, 100));
    }
    throw new AlphaPageStateError(`已开启自动点击网页确认，但 ${this.config.confirmButtonTimeoutMs} 毫秒内未找到可点击的“${this.config.confirmButtonText}”按钮（可见同名按钮 ${visibleCandidates} 次）`);
  }

  async waitForBothOrdersFilled(page: Page, bodyBeforeSubmit: string) {
    const deadline = Date.now() + this.config.orderResultTimeoutMs;
    let buyFilled = false;
    let sellFilled = false;
    while (Date.now() < deadline) {
      await this.assertAuthenticated(page);
      const text = await page.locator('body').innerText();
      // Existing historical toast content cannot make a new order succeed.
      if (text !== bodyBeforeSubmit) {
        buyFilled ||= text.includes(this.config.buyFilledText);
        sellFilled ||= text.includes(this.config.sellFilledText);
      }
      if (buyFilled && sellFilled) return;
      await page.waitForTimeout(this.config.pollIntervalMs);
    }
    throw new AlphaOrderResultTimeoutError(`等待买卖双向成交超时：买单 ${buyFilled ? '已确认' : '未确认'}，卖单 ${sellFilled ? '已确认' : '未确认'}`);
  }
}
