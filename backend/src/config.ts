import "dotenv/config";
import { z } from "zod";

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
  paperMaxOpenLimitOrders: number;
  marketWsReconnectMs: number;
  marketRestPollSeconds: number;
  corsOrigins: true | string[];
  appPassword: string;
  authTokenTtlSeconds: number;
};

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  BINANCE_API_KEY: z.string().default(""),
  BINANCE_SECRET: z.string().default(""),
  BINANCE_SANDBOX: z.enum(["true", "false"]).default("true"),
  DEFAULT_SYMBOLS: z.string().default("BTC/USDT,ETH/USDT,SOL/USDT"),
  PAPER_STARTING_CASH: z.coerce.number().positive().default(100_000),
  PAPER_MAKER_FEE_RATE: z.coerce.number().min(0).max(1).default(0.0002),
  PAPER_TAKER_FEE_RATE: z.coerce.number().min(0).max(1).default(0.0005),
  PAPER_LIMIT_FILL_RATIO: z.coerce.number().positive().max(1).default(0.5),
  PAPER_MAX_OPEN_LIMIT_ORDERS: z.coerce.number().int().positive().default(200),
  MARKET_WS_RECONNECT_MS: z.coerce.number().int().positive().default(3000),
  MARKET_REST_POLL_SECONDS: z.coerce.number().positive().default(3),
  CORS_ORIGINS: z.string().default("*"),
  APP_PASSWORD: z.string().default(""),
  AUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(43_200)
});

const env = envSchema.parse(process.env);
const defaultSymbols = env.DEFAULT_SYMBOLS.split(",").map((symbol) => symbol.trim()).filter(Boolean);
if (defaultSymbols.length === 0) throw new Error("DEFAULT_SYMBOLS 至少需要配置一个交易对");

export const config: AppConfig = {
  port: env.PORT,
  binanceApiKey: env.BINANCE_API_KEY,
  binanceSecret: env.BINANCE_SECRET,
  binanceSandbox: env.BINANCE_SANDBOX === "true",
  defaultSymbols,
  paperStartingCash: env.PAPER_STARTING_CASH,
  paperMakerFeeRate: env.PAPER_MAKER_FEE_RATE,
  paperTakerFeeRate: env.PAPER_TAKER_FEE_RATE,
  paperLimitFillRatio: env.PAPER_LIMIT_FILL_RATIO,
  paperMaxOpenLimitOrders: env.PAPER_MAX_OPEN_LIMIT_ORDERS,
  marketWsReconnectMs: env.MARKET_WS_RECONNECT_MS,
  marketRestPollSeconds: env.MARKET_REST_POLL_SECONDS,
  corsOrigins: env.CORS_ORIGINS === "*" ? true : env.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
  appPassword: env.APP_PASSWORD,
  authTokenTtlSeconds: env.AUTH_TOKEN_TTL_SECONDS
};
