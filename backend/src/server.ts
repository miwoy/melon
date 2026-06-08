import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { AccountManager } from "./accounts/AccountManager.js";
import { AuthService } from "./auth/AuthService.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { BinanceExchange } from "./exchange/BinanceExchange.js";
import { BinanceMarketStream } from "./market/BinanceMarketStream.js";
import { createAccountSchema, createOrderSchema, idParamSchema, loginSchema, paginationSchema, positionRiskSchema, switchAccountSchema } from "./schemas.js";
import type { CreateOrderRequest, Ticker } from "./types.js";
import { EventHub } from "./ws/EventHub.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(websocket);

const exchange = new BinanceExchange(config);
const accountManager = new AccountManager();
await accountManager.initialize();
const auth = new AuthService(config.appPassword, config.authTokenTtlSeconds);
const hub = new EventHub();
const tickers = new Map<string, Ticker>();

app.addHook("onRequest", async (request, reply) => {
  if (!auth.required()) return;
  if (isPublicRoute(request.url)) return;
  const token = tokenFromHeader(request.headers.authorization);
  if (!auth.verify(token)) return reply.code(401).send({ error: "请先登录" });
});

app.get("/health", async () => ({ ok: true }));

app.get("/api/auth/status", async () => ({ required: auth.required() }));

app.post("/api/auth/login", async (request, reply) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const session = auth.login(parsed.data.password);
  if (!session) return reply.code(401).send({ error: "密码错误" });
  return session;
});

app.get("/api/symbols", async () => ({ symbols: config.defaultSymbols }));

app.get("/api/tickers", async () => Object.fromEntries(tickers));

app.get("/api/accounts", async () => accountManager.list());

app.post("/api/accounts", async (request, reply) => {
  const parsed = createAccountSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const account = await accountManager.create(parsed.data);
  accountManager.seedTickers([...tickers.values()]);
  return { id: account.id, name: account.name, kind: account.kind, isActive: false, cash: account.cash, createdAt: account.createdAt.getTime() };
});

app.put("/api/accounts/active", async (request, reply) => {
  const parsed = switchAccountSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  try {
    const snapshot = await accountManager.switch(parsed.data.accountId);
    accountManager.seedTickers([...tickers.values()]);
    hub.broadcast({ type: "account", data: snapshot });
    return snapshot;
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : "账户切换失败" });
  }
});

app.get("/api/account", async () => accountManager.snapshot());

app.get("/api/account/stats", async () => accountManager.accountStats());

app.get("/api/orders/history", async (request, reply) => {
  const parsed = paginationSchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  return accountManager.paginatedOrders(parsed.data);
});

app.get("/api/positions/history", async (request, reply) => {
  const parsed = paginationSchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  return accountManager.paginatedPositionHistory(parsed.data);
});

app.post("/api/orders", async (request, reply) => {
  const parsed = createOrderSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const order = await submitOrder(parsed.data);
  return order;
});

app.delete("/api/orders/:id", async (request, reply) => {
  const parsed = idParamSchema.safeParse(request.params);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  try {
    const order = await accountManager.cancelPaperOrder(parsed.data.id);
    hub.broadcast({ type: "order", data: order });
    hub.broadcast({ type: "account", data: await accountManager.snapshot() });
    return order;
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : "取消委托失败" });
  }
});

app.patch("/api/positions/:id/risk", async (request, reply) => {
  const params = idParamSchema.safeParse(request.params);
  const body = positionRiskSchema.safeParse(request.body);
  if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
  try {
    const snapshot = await accountManager.updatePaperPositionRisk({ positionId: params.data.id, ...body.data });
    hub.broadcast({ type: "account", data: snapshot });
    return snapshot;
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : "设置止盈止损失败" });
  }
});

app.get("/ws", { websocket: true }, (socket, request) => {
  if (!auth.verify(tokenFromWsUrl(request.url))) {
    socket.close(1008, "unauthorized");
    return;
  }
  hub.add(socket);
  socket.send(JSON.stringify({ type: "tickers", data: Object.fromEntries(tickers) }));
  accountManager.snapshot().then((snapshot) => socket.send(JSON.stringify({ type: "account", data: snapshot })));
});

const marketStream = new BinanceMarketStream(config.defaultSymbols, config.marketWsReconnectMs, (ticker) => {
  lastMarketTickAt = Date.now();
  void handleTicker(ticker);
});
let lastMarketTickAt = 0;

const restPollTimer = setInterval(() => {
  const stale = Date.now() - lastMarketTickAt > config.marketRestPollSeconds * 1000;
  if (!stale) return;
  for (const symbol of config.defaultSymbols) {
    exchange
      .fetchTicker(symbol)
      .then((ticker) => handleTicker(ticker))
      .catch((error) => app.log.warn({ err: error, symbol }, "REST ticker fallback failed"));
  }
}, config.marketRestPollSeconds * 1000);

const tickerStatsTimer = setInterval(() => {
  for (const symbol of config.defaultSymbols) {
    exchange
      .fetchTicker(symbol)
      .then((ticker) => handleTicker(ticker))
      .catch((error) => app.log.warn({ err: error, symbol }, "24h ticker stats refresh failed"));
  }
}, 30_000);

const authSweepTimer = setInterval(() => auth.sweep(), 60_000);

async function handleTicker(ticker: Ticker) {
  const mergedTicker = mergeTicker(ticker);
  tickers.set(mergedTicker.symbol, mergedTicker);
  const filledOrders = await accountManager.updateTicker(mergedTicker);
  for (const order of filledOrders) {
    hub.broadcast({ type: "order", data: order });
  }
  hub.broadcast({ type: "tickers", data: Object.fromEntries(tickers) });
  hub.broadcast({ type: "account", data: await accountManager.snapshot() });
}

function mergeTicker(ticker: Ticker): Ticker {
  const previous = tickers.get(ticker.symbol);
  return {
    ...previous,
    ...ticker,
    bid: ticker.bid ?? previous?.bid,
    ask: ticker.ask ?? previous?.ask,
    percentage: ticker.percentage ?? previous?.percentage,
    ts: ticker.ts
  };
}

async function submitOrder(request: CreateOrderRequest) {
  const account = await accountManager.activeAccount();
  const normalized = normalizeOrderAmount(request);
  if (!normalized.ok) {
    return rejectedOrder(request, account.id, normalized.reason);
  }
  request = normalized.request;
  if (account.kind === "live") {
    if (!config.binanceApiKey || !config.binanceSecret) {
      return rejectedOrder(request, account.id, "真实盘交易需要配置 BINANCE_API_KEY 和 BINANCE_SECRET");
    }
    const result = await exchange.createOrder(request.symbol, request.side, request.type, request.amount, request.price);
    return {
      id: String(result.id),
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      amount: request.amount,
      filledAmount: Number(result.filled ?? result.amount ?? request.amount),
      remainingAmount: Number(result.remaining ?? 0),
      avgFillPrice: Number(result.average ?? result.price ?? 0),
      price: Number(result.price ?? result.average ?? 0),
      leverage: request.leverage,
      fee: 0,
      margin: 0,
      status: Number(result.remaining ?? 0) > 0 ? "partial" as const : "filled" as const,
      accountId: account.id,
      createdAt: Date.now()
    };
  }

  const order = await accountManager.executePaper({ ...request, accountId: account.id });
  hub.broadcast({ type: "order", data: order });
  hub.broadcast({ type: "account", data: await accountManager.snapshot() });
  return order;
}

function normalizeOrderAmount(request: CreateOrderRequest):
  | { ok: true; request: CreateOrderRequest }
  | { ok: false; reason: string } {
  if (request.amountUnit !== "quote") return { ok: true, request };
  const referencePrice = request.type === "limit" ? request.price : tickers.get(request.symbol)?.last;
  if (!referencePrice || !Number.isFinite(referencePrice)) {
    return { ok: false, reason: "使用 USDT 金额下单时需要可用价格" };
  }
  return { ok: true, request: { ...request, amount: request.amount / referencePrice, amountUnit: "base" } };
}

function rejectedOrder(request: CreateOrderRequest, accountId: string, reason: string) {
  return {
    id: "rejected-" + Date.now(),
    symbol: request.symbol,
    side: request.side,
    type: request.type,
    amount: request.amount,
    filledAmount: 0,
    remainingAmount: 0,
    avgFillPrice: 0,
    price: request.price ?? 0,
    leverage: request.leverage,
    fee: 0,
    margin: 0,
    status: "rejected" as const,
    accountId,
    reason,
    createdAt: Date.now()
  };
}

function isPublicRoute(url: string) {
  const pathname = url.split("?")[0];
  return pathname === "/health" || pathname === "/api/auth/status" || pathname === "/api/auth/login" || pathname === "/ws";
}

function tokenFromHeader(header?: string) {
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

function tokenFromWsUrl(url: string) {
  const query = url.split("?")[1];
  if (!query) return undefined;
  return new URLSearchParams(query).get("token") ?? undefined;
}

for (const symbol of config.defaultSymbols) {
  exchange.fetchTicker(symbol).then((ticker) => {
    tickers.set(symbol, ticker);
    void accountManager.updateTicker(ticker);
  }).catch((error) => app.log.warn({ err: error, symbol }, "REST ticker warmup failed"));
}

marketStream.start();

const close = async () => {
  clearInterval(restPollTimer);
  clearInterval(tickerStatsTimer);
  clearInterval(authSweepTimer);
  marketStream.stop();
  await prisma.$disconnect();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);

await app.listen({ port: config.port, host: "0.0.0.0" });
