import type { AccountSnapshot, CreateOrderRequest, StrategyConfig, Ticker } from "../types.js";
import type { Strategy, StrategyContext, StrategyState } from "./Strategy.js";

const initialConfig: StrategyConfig = {
  enabled: false,
  symbol: "BTC/USDT",
  shortWindow: 5,
  longWindow: 20,
  tradeAmount: 0.001
};

export class MovingAverageCrossStrategy implements Strategy {
  private config = initialConfig;
  private prices: number[] = [];
  private previousDiff?: number;
  private lastSignal = "空闲";

  configure(config: StrategyConfig) {
    this.config = config;
    this.prices = [];
    this.previousDiff = undefined;
    this.lastSignal = config.enabled ? "等待行情" : "未启用";
  }

  onTicker(ticker: Ticker, context: StrategyContext) {
    if (!this.config.enabled || ticker.symbol !== this.config.symbol) return;

    this.prices.push(ticker.last);
    this.prices = this.prices.slice(-this.config.longWindow);
    if (this.prices.length < this.config.longWindow) {
      this.lastSignal = "数据预热中";
      return;
    }

    const short = average(this.prices.slice(-this.config.shortWindow));
    const long = average(this.prices);
    const diff = short - long;
    const account = context.account;

    if (this.previousDiff !== undefined && this.previousDiff <= 0 && diff > 0) {
      context.submitOrder(this.order("buy"));
      this.lastSignal = `买入信号 短均线=${short.toFixed(2)} 长均线=${long.toFixed(2)}`;
    } else if (this.previousDiff !== undefined && this.previousDiff >= 0 && diff < 0 && hasPosition(account, this.config.symbol)) {
      context.submitOrder(this.order("sell"));
      this.lastSignal = `卖出信号 短均线=${short.toFixed(2)} 长均线=${long.toFixed(2)}`;
    } else {
      this.lastSignal = `观望 短均线=${short.toFixed(2)} 长均线=${long.toFixed(2)}`;
    }

    this.previousDiff = diff;
  }

  state(): StrategyState {
    return { ...this.config, lastSignal: this.lastSignal, prices: this.prices };
  }

  private order(side: "buy" | "sell"): CreateOrderRequest {
    return {
      symbol: this.config.symbol,
      side,
      type: "market",
      amount: this.config.tradeAmount,
      leverage: 1,
      accountId: this.config.accountId
    };
  }
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hasPosition(account: AccountSnapshot, symbol: string) {
  return account.positions.some((position) => position.symbol === symbol && position.amount > 0);
}
