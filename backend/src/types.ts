export type AccountKind = "paper" | "live";
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";
export type AmountUnit = "base" | "quote";
export type OrderStatus = "open" | "partial" | "filled" | "rejected" | "canceled";
export type PositionSide = "long" | "short";
export type PositionStatus = "open" | "closed";

export type Ticker = {
  symbol: string;
  last: number;
  bid?: number;
  ask?: number;
  percentage?: number;
  ts: number;
};

export type Position = {
  id: string;
  symbol: string;
  base: string;
  quote: string;
  side: PositionSide;
  status: PositionStatus;
  amount: number;
  openedAmount: number;
  closedAmount: number;
  avgEntry: number;
  closeAvgPrice: number;
  markPrice: number;
  marketValue: number;
  liquidationPrice: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  leverage: number;
  margin: number;
  openedMargin: number;
  realizedPnl: number;
  unrealizedPnl: number;
  fees: number;
  netPnl: number;
  roi: number;
  openedAt: number;
  closedAt?: number;
};

export type Order = {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  amount: number;
  filledAmount: number;
  remainingAmount: number;
  avgFillPrice: number;
  price: number;
  leverage: number;
  fee: number;
  closePnl: number;
  margin: number;
  status: OrderStatus;
  accountId: string;
  positionId?: string;
  reason?: string;
  createdAt: number;
};

export type AccountSnapshot = {
  accountId: string;
  accountName: string;
  accountKind: AccountKind;
  cash: number;
  equity: number;
  usedMargin: number;
  realizedPnl: number;
  totalFees: number;
  positions: Position[];
  orders: Order[];
};

export type Paginated<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type CreateOrderRequest = {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  amount: number;
  price?: number;
  leverage: number;
  amountUnit?: AmountUnit;
  accountId?: string;
};

export type UpdatePositionRiskRequest = {
  positionId: string;
  takeProfitPrice?: number | null;
  stopLossPrice?: number | null;
};

export type StrategyConfig = {
  enabled: boolean;
  symbol: string;
  shortWindow: number;
  longWindow: number;
  tradeAmount: number;
  accountId?: string;
};

export type TradingAccount = {
  id: string;
  name: string;
  kind: AccountKind;
  isActive: boolean;
  cash: number;
  equity?: number;
  createdAt: number;
};

export type AppEvent =
  | { type: "tickers"; data: Record<string, Ticker> }
  | { type: "account"; data: AccountSnapshot }
  | { type: "order"; data: Order };
