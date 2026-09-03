export type ObservedTrade = {
  timestamp: number;
  price: number;
  quantity: number;
  side: 'buy' | 'sell';
};

export type StrategyConfig = {
  windowSeconds: number;
  minimumSamples: number;
  uptrendThreshold: number;
  sidewaysThreshold: number;
  minVolatilityPercent: number;
  maxVolatilityPercent: number;
  sidewaysMaxRangePercent: number;
  targetSpreadBps: number;
};

export type StrategyDecision = {
  suitable: boolean;
  strategy: 'uptrend' | 'sideways' | 'none';
  confidence: number;
  price: number;
  expectedSellPrice: number;
  reason: string;
};

const average = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;

export const retainRecentTrades = (trades: readonly ObservedTrade[], now: number, windowSeconds: number) =>
  trades.filter(trade => trade.timestamp >= now - windowSeconds * 1_000);

/** Pure strategy copied as behavior, not as browser-extension code. */
export const analyzeOpportunity = (
  history: readonly ObservedTrade[],
  config: StrategyConfig,
  now = Date.now(),
): StrategyDecision => {
  const recent = retainRecentTrades(history, now, config.windowSeconds);
  if (recent.length < config.minimumSamples) {
    return {suitable: false, strategy: 'none', confidence: 0, price: 0, expectedSellPrice: 0, reason: `样本不足 ${recent.length}/${config.minimumSamples}`};
  }

  const prices = recent.map(item => item.price);
  const price = prices.at(-1)!;
  const averagePrice = average(prices);
  const variance = average(prices.map(value => (value - averagePrice) ** 2));
  const volatilityPercent = averagePrice > 0 ? Math.sqrt(variance) / averagePrice * 100 : Number.POSITIVE_INFINITY;
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const rangePercent = averagePrice > 0 ? (maxPrice - minPrice) / averagePrice * 100 : Number.POSITIVE_INFINITY;
  const position = maxPrice === minPrice ? 0.5 : (price - minPrice) / (maxPrice - minPrice);
  const lastFive = prices.slice(-5);
  const lastTen = prices.slice(-10);
  const ma5 = average(lastFive);
  const ma10 = average(lastTen);
  const buyQuantity = recent.filter(item => item.side === 'buy').reduce((total, item) => total + item.quantity, 0);
  const totalQuantity = recent.reduce((total, item) => total + item.quantity, 0);
  const buyRatio = totalQuantity > 0 ? buyQuantity / totalQuantity : 0.5;
  const priceChange1 = prices.at(-1)! - prices.at(-2)!;
  const priceChange2 = prices.at(-2)! - prices.at(-3)!;

  let uptrend = 0;
  const uptrendReasons: string[] = [];
  if (volatilityPercent >= config.minVolatilityPercent && volatilityPercent <= config.maxVolatilityPercent) {
    uptrend += 0.25;
    uptrendReasons.push(`波动 ${volatilityPercent.toFixed(4)}%`);
  }
  if (ma5 > ma10 && priceChange1 > 0 && priceChange1 - priceChange2 > 0) {
    uptrend += 0.25;
    uptrendReasons.push('上升加速');
  } else if (ma5 > ma10 && priceChange1 > 0) {
    uptrend += 0.12;
    uptrendReasons.push('上升趋势');
  }
  if (buyRatio > 0.65) {
    uptrend += 0.18;
    uptrendReasons.push(`强买压 ${(buyRatio * 100).toFixed(1)}%`);
  } else if (buyRatio > 0.58) {
    uptrend += 0.10;
    uptrendReasons.push(`买压 ${(buyRatio * 100).toFixed(1)}%`);
  }
  if (position < 0.4) {
    uptrend += 0.15;
    uptrendReasons.push('低位');
  } else if (position < 0.6) {
    uptrend += 0.05;
    uptrendReasons.push('中位');
  }
  const recentQuantity = average(recent.slice(-5).map(item => item.quantity));
  if (recentQuantity > average(recent.map(item => item.quantity)) * 1.2) {
    uptrend += 0.10;
    uptrendReasons.push('量增');
  }

  let sideways = 0;
  const sidewaysReasons: string[] = [];
  if (volatilityPercent < 0.01 && rangePercent > 0 && rangePercent < config.sidewaysMaxRangePercent) {
    sideways = 0.30;
    sidewaysReasons.push(`横盘 ${rangePercent.toFixed(4)}%`);
    if (position < 0.25) { sideways += 0.18; sidewaysReasons.push('接近下沿'); }
    else if (position > 0.75) { sideways += 0.12; sidewaysReasons.push('接近上沿'); }
    if (priceChange1 > 0) { sideways += 0.12; sidewaysReasons.push('反弹'); }
    if (buyRatio > 0.48 && buyRatio < 0.52) { sideways += 0.10; sidewaysReasons.push('买卖平衡'); }
  }

  const strategy = uptrend >= sideways ? 'uptrend' : 'sideways';
  const confidence = strategy === 'uptrend' ? uptrend : sideways;
  const threshold = strategy === 'uptrend' ? config.uptrendThreshold : config.sidewaysThreshold;
  const suitable = confidence >= threshold;
  const reasons = strategy === 'uptrend' ? uptrendReasons : sidewaysReasons;
  return {
    suitable,
    strategy,
    confidence,
    price,
    expectedSellPrice: price * (1 + config.targetSpreadBps / 10_000),
    reason: suitable
      ? `${strategy}：${reasons.join('，') || '达到阈值'}`
      : `${strategy} 信心 ${(confidence * 100).toFixed(0)}%/${(threshold * 100).toFixed(0)}%，${reasons.join('，') || '无有效信号'}`,
  };
};
