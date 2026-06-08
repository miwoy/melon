import WebSocket from "ws";
import type { Ticker } from "../types.js";

type TickHandler = (ticker: Ticker) => void;

export class BinanceMarketStream {
  private ws?: WebSocket;
  private watchdog?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private lastMessageAt = 0;
  private readonly tickerCache = new Map<string, Ticker>();
  private readonly lastEmitAt = new Map<string, number>();
  private readonly emitTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly symbols: string[],
    private readonly reconnectMs: number,
    private readonly onTick: TickHandler
  ) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearEmitTimers();
    this.ws?.close();
  }

  private connect() {
    if (this.stopped) return;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearEmitTimers();
    this.lastMessageAt = Date.now();
    const streams = this.symbols
      .flatMap((symbol) => [`${toStreamSymbol(symbol)}@ticker`, `${toStreamSymbol(symbol)}@bookTicker`])
      .join("/");
    this.ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);

    this.ws.on("message", (raw) => {
      this.lastMessageAt = Date.now();
      let parsed: { stream?: string; data?: Record<string, string> };
      try {
        parsed = JSON.parse(raw.toString()) as { stream?: string; data?: Record<string, string> };
      } catch {
        return;
      }
      const data = parsed.data;
      if (!data?.s) return;
      const previous = this.tickerCache.get(fromStreamSymbol(data.s));
      const bid = optionalNumber(data.b) ?? previous?.bid;
      const ask = optionalNumber(data.a) ?? previous?.ask;
      const mid = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined;
      const next: Ticker = {
        ...previous,
        symbol: fromStreamSymbol(data.s),
        last: optionalNumber(data.c) ?? mid ?? previous?.last ?? 0,
        bid,
        ask,
        percentage: optionalNumber(data.P) ?? previous?.percentage,
        ts: Date.now()
      };
      if (!next.last) return;
      this.tickerCache.set(next.symbol, next);
      this.emitThrottled(next.symbol);
    });

    this.ws.on("close", () => this.reconnect());
    this.ws.on("error", () => this.ws?.close());
    this.watchdog = setInterval(() => {
      if (this.stopped) return;
      if (Date.now() - this.lastMessageAt > 15_000) this.ws?.close();
    }, this.reconnectMs);
  }

  private reconnect() {
    if (this.stopped) return;
    if (this.watchdog) clearInterval(this.watchdog);
    this.clearEmitTimers();
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
  }

  private emitThrottled(symbol: string) {
    const now = Date.now();
    const lastEmitAt = this.lastEmitAt.get(symbol) ?? 0;
    const elapsed = now - lastEmitAt;
    if (elapsed >= 500) {
      this.emit(symbol);
      return;
    }

    if (this.emitTimers.has(symbol)) return;
    const timer = setTimeout(() => {
      this.emitTimers.delete(symbol);
      this.emit(symbol);
    }, 500 - elapsed);
    this.emitTimers.set(symbol, timer);
  }

  private emit(symbol: string) {
    const ticker = this.tickerCache.get(symbol);
    if (!ticker) return;
    this.lastEmitAt.set(symbol, Date.now());
    this.onTick(ticker);
  }

  private clearEmitTimers() {
    for (const timer of this.emitTimers.values()) clearTimeout(timer);
    this.emitTimers.clear();
  }
}

function toStreamSymbol(symbol: string) {
  return symbol.replace("/", "").toLowerCase();
}

function fromStreamSymbol(symbol: string) {
  if (symbol.endsWith("USDT")) return `${symbol.slice(0, -4)}/USDT`;
  if (symbol.endsWith("BTC")) return `${symbol.slice(0, -3)}/BTC`;
  if (symbol.endsWith("ETH")) return `${symbol.slice(0, -3)}/ETH`;
  return symbol;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
