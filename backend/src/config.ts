import "dotenv/config";

export type AppConfig = {
  port: number;
  binanceApiKey: string;
  binanceSecret: string;
  binanceSandbox: boolean;
  defaultSymbols: string[];
  paperStartingCash: number;
  paperMakerFeeRate: number;
  paperTakerFeeRate: number;
  paperLimitFillRatio: number;
  marketWsReconnectMs: number;
  marketRestPollSeconds: number;
  appPassword: string;
  authTokenTtlSeconds: number;
};

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 4000),
  binanceApiKey: process.env.BINANCE_API_KEY ?? "",
  binanceSecret: process.env.BINANCE_SECRET ?? "",
  binanceSandbox: (process.env.BINANCE_SANDBOX ?? "true") === "true",
  defaultSymbols: (process.env.DEFAULT_SYMBOLS ?? "BTC/USDT,ETH/USDT,SOL/USDT")
    .split(",")
    .map((symbol) => symbol.trim())
    .filter(Boolean),
  paperStartingCash: Number(process.env.PAPER_STARTING_CASH ?? 100_000),
  paperMakerFeeRate: Number(process.env.PAPER_MAKER_FEE_RATE ?? 0.0002),
  paperTakerFeeRate: Number(process.env.PAPER_TAKER_FEE_RATE ?? 0.0005),
  paperLimitFillRatio: Number(process.env.PAPER_LIMIT_FILL_RATIO ?? 0.5),
  marketWsReconnectMs: Number(process.env.MARKET_WS_RECONNECT_MS ?? 3000),
  marketRestPollSeconds: Number(process.env.MARKET_REST_POLL_SECONDS ?? 3),
  appPassword: process.env.APP_PASSWORD ?? "",
  authTokenTtlSeconds: Number(process.env.AUTH_TOKEN_TTL_SECONDS ?? 43_200)
};
