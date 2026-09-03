export type OrderSide = 'buy' | 'sell';

export type OrderStatus = 'new' | 'partially-filled' | 'filled' | 'canceled' | 'rejected' | 'unknown';

export type PartialFillPolicy = 'cancel-remainder-and-sell-filled' | 'manual-stop';
export type UnknownStatePolicy = 'manual-stop' | 'retry-observe';

export type OrderSnapshot = {
  id: string;
  side: OrderSide;
  status: OrderStatus;
  requestedQty: number;
  filledQty: number;
  remainingQty: number;
  price?: number;
};

export type OrderLifecycleState =
  | 'idle'
  | 'buy-submitting'
  | 'buy-open'
  | 'buy-partial'
  | 'buy-filled'
  | 'sell-open'
  | 'sell-partial'
  | 'recovering-buy'
  | 'recovering-sell'
  | 'sell-submitting'
  | 'completed'
  | 'manual-review'
  | 'failed';

export type OrderLifecycle = {
  state: OrderLifecycleState;
  buyOrder?: OrderSnapshot;
  sellOrder?: OrderSnapshot;
  repriceAttempts: number;
  lastReason?: string;
};

export type OrderLifecyclePolicy = {
  maxRepriceAttempts: number;
  repriceStepBps: number;
  maxAllowedLossBps: number;
  partialFillPolicy: PartialFillPolicy;
  unknownStatePolicy: UnknownStatePolicy;
  autoRecoverUnfilledSell: boolean;
};

export type OrderLifecycleEvent =
  | {type: 'start'}
  | {type: 'orders-observed'; buy?: OrderSnapshot; sell?: OrderSnapshot}
  | {type: 'fills-confirmed'; reason?: string}
  | {type: 'sell-timeout'}
  | {type: 'cancel-confirmed'; side: OrderSide}
  | {type: 'reprice-submitted'; order: OrderSnapshot}
  | {type: 'state-unknown'; reason: string}
  | {type: 'cancel-failed'; side: OrderSide; reason: string}
  | {type: 'reprice-failed'; reason: string}
  | {type: 'failed'; reason: string};

export type OrderLifecycleCommand =
  | {type: 'submit-entry'}
  | {type: 'cancel-order-remainder'; side: OrderSide; orderId: string; remainingQty: number}
  | {type: 'place-sell'; quantity: number; repriceAttempt: number; priceOffsetBps: number}
  | {type: 'observe-again'; reason: string}
  | {type: 'manual-review'; reason: string};

export type OrderLifecycleTransition = {
  lifecycle: OrderLifecycle;
  commands: OrderLifecycleCommand[];
};
