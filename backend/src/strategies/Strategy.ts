import type { AccountSnapshot, CreateOrderRequest, StrategyConfig, Ticker } from "../types.js";

export type StrategyContext = {
  account: AccountSnapshot;
  submitOrder: (order: CreateOrderRequest) => void;
};

export type StrategyState = StrategyConfig & {
  lastSignal: string;
  prices: number[];
};

export interface Strategy {
  configure(config: StrategyConfig): void;
  onTicker(ticker: Ticker, context: StrategyContext): void;
  state(): StrategyState;
}
