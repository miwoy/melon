import ccxt from "ccxt";
import type { AppConfig } from "../config.js";
import type { OrderSide, OrderType, Ticker } from "../types.js";

export class BinanceExchange {
  private readonly client: InstanceType<typeof ccxt.binanceusdm>;

  constructor(config: AppConfig) {
    this.client = new ccxt.binanceusdm({
      enableRateLimit: true,
      apiKey: config.binanceApiKey || undefined,
      secret: config.binanceSecret || undefined,
      options: { defaultType: "swap" }
    });

    if (config.binanceSandbox) {
      this.client.setSandboxMode(true);
    }
  }

  async fetchTicker(symbol: string): Promise<Ticker> {
    const data = await this.client.fetchTicker(symbol);
    return {
      symbol,
      last: Number(data.last ?? data.close ?? 0),
      bid: optionalNumber(data.bid),
      ask: optionalNumber(data.ask),
      percentage: optionalNumber(data.percentage),
      ts: Date.now()
    };
  }

  async createOrder(symbol: string, side: OrderSide, type: OrderType, amount: number, price?: number) {
    return this.client.createOrder(symbol, type, side, amount, price);
  }
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
