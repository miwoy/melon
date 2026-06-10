import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { AccountManager } from "./accounts/AccountManager.js";
import { AuthService } from "./auth/AuthService.js";
import { BotRegistry } from "./bots/BotRegistry.js";
import { BotRuntime } from "./bots/BotRuntime.js";
import { randomBotDefinition } from "./bots/definitions/RandomBot.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { BinanceExchange } from "./exchange/BinanceExchange.js";
import { BinanceMarketStream } from "./market/BinanceMarketStream.js";
import { accountQuerySchema, createAccountSchema, createOrderSchema, idParamSchema, loginSchema, paginationSchema, positionRiskSchema, switchAccountSchema } from "./schemas.js";
import type { CreateOrderRequest, Ticker } from "./types.js";
import { EventHub } from "./ws/EventHub.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: config.corsOrigins });
await app.register(websocket);

const exchange = new BinanceExchange(config);
const accountManager = new AccountManager();
await accountManager.initialize();
const botRegistry = new BotRegistry();
botRegistry.register(randomBotDefinition);
const botRuntime = new BotRuntime(accountManager, botRegistry);
const auth = new AuthService(config.appPassword, config.authTokenTtlSeconds);
const hub = new EventHub();
const tickers = new Map<string, Ticker>();
const TICKER_STATS_REFRESH_MS = 30_000;
const AUTH_SWEEP_MS = 60_000;

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

app.get("/api/bots/definitions", async () => ({ items: botRuntime.definitions() }));

app.post("/api/accounts", async (request, reply) => {
  const parsed = createAccountSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const account = await accountManager.create(parsed.data);
  accountManager.seedTickers([...tickers.values()]);
  return {
    id: account.id,
    name: account.name,
    kind: account.kind,
    mode: account.mode,
    botType: account.botType,
    botStatus: account.botStatus,
    botStartedAt: account.startedAt?.getTime(),
    botStoppedAt: account.stoppedAt?.getTime(),
    isActive: false,
    cash: account.cash,
    createdAt: account.createdAt.getTime()
  };
});

app.put("/api/accounts/active", async (request, reply) => {
  const parsed = switchAccountSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  try {
    const snapshot = await accountManager.switch(parsed.data.accountId);
    accountManager.seedTickers([...tickers.values()]);
    return snapshot;
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : "账户切换失败" });
  }
});

app.get("/api/accounts/:id/snapshot", async (request, reply) => {
  const params = idParamSchema.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
  try {
    return await accountManager.snapshotFor(params.data.id);
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : "账户不存在" });
  }
});

app.patch("/api/accounts/:id/archive", async (request, reply) => {
  const params = idParamSchema.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
  try {
    const snapshot = await accountManager.archiveAccount(params.data.id);
    const accounts = await accountManager.list();
    return { accounts, account: snapshot };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "归档账户失败" });
  }
});

app.delete("/api/accounts/:id", async (request, reply) => {
  const params = idParamSchema.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
  try {
    const snapshot = await accountManager.deleteAccount(params.data.id);
    const accounts = await accountManager.list();
    return { accounts, account: snapshot };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "删除账户失败" });
  }
});

app.post("/api/bots/stop", async (request, reply) => {
  const parsed = accountQuerySchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  if (!parsed.data.accountId) return reply.code(400).send({ error: "必须指定账户" });
  try {
    const accountId = parsed.data.accountId;
    await accountManager.stopBot(accountId, "用户终止机器人", "stopped");
    const snapshot = await accountManager.snapshotFor(accountId);
    hub.broadcastAccount(accountId, { type: "account", data: snapshot });
    return snapshot;
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "终止机器人失败" });
  }
});

app.get("/api/account", async () => accountManager.snapshot());

app.get("/api/account/stats", async (request, reply) => {
  const parsed = accountQuerySchema.safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  return accountManager.accountStats(parsed.data.accountId);
});

app.get("/api/orders/history", async (request, reply) => {
  const parsed = paginationSchema.merge(accountQuerySchema).safeParse(request.query);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  return accountManager.paginatedOrders(parsed.data);
});

app.get("/api/positions/history", async (request, reply) => {
  const parsed = paginationSchema.merge(accountQuerySchema).safeParse(request.query);
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
    const query = accountQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    if (!query.data.accountId) return reply.code(400).send({ error: "必须指定账户" });
    const order = await accountManager.cancelPaperOrderForAccount(query.data.accountId, parsed.data.id);
    hub.broadcast({ type: "order", data: order });
    hub.broadcastAccount(order.accountId, { type: "account", data: await accountManager.snapshotFor(order.accountId) });
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
    const query = accountQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.flatten() });
    if (!query.data.accountId) return reply.code(400).send({ error: "必须指定账户" });
    const snapshot = await accountManager.updatePaperPositionRiskForAccount(query.data.accountId, { positionId: params.data.id, ...body.data });
    hub.broadcastAccount(snapshot.accountId, { type: "account", data: snapshot });
    return snapshot;
  } catch (error) {
    return reply.code(404).send({ error: error instanceof Error ? error.message : "设置止盈止损失败" });
  }
});

app.get("/ws", { websocket: true }, (socket, request) => {
  const accountId = accountIdFromWsUrl(request.url);
  const authenticate = () => {
    hub.add(socket, { accountId });
    socket.send(JSON.stringify({ type: "tickers", data: Object.fromEntries(tickers) }));
    const snapshotPromise = accountId ? accountManager.snapshotFor(accountId) : accountManager.snapshot();
    snapshotPromise.then((snapshot) => socket.send(JSON.stringify({ type: "account", data: snapshot })));
  };

  if (!auth.required() || auth.verify(tokenFromWsUrl(request.url))) {
    authenticate();
    return;
  }

  const authTimer = setTimeout(() => socket.close(1008, "unauthorized"), 5000);
  socket.once("message", (raw) => {
    clearTimeout(authTimer);
    try {
      const message = JSON.parse(String(raw)) as { type?: string; token?: string };
      if (message.type !== "auth" || !auth.verify(message.token)) {
        socket.close(1008, "unauthorized");
        return;
      }
      authenticate();
    } catch {
      socket.close(1008, "unauthorized");
    }
  });
});

const marketStream = new BinanceMarketStream(config.defaultSymbols, config.marketWsReconnectMs, (ticker) => {
  lastMarketTickAt = Date.now();
  enqueueTicker(ticker);
});
let lastMarketTickAt = 0;
let tickerQueue = Promise.resolve();

const restPollTimer = setInterval(() => {
  const stale = Date.now() - lastMarketTickAt > config.marketRestPollSeconds * 1000;
  if (!stale) return;
  for (const symbol of config.defaultSymbols) {
    exchange
      .fetchTicker(symbol)
      .then((ticker) => enqueueTicker(ticker))
      .catch((error) => app.log.warn({ err: error, symbol }, "REST ticker fallback failed"));
  }
}, config.marketRestPollSeconds * 1000);

const tickerStatsTimer = setInterval(() => {
  for (const symbol of config.defaultSymbols) {
    exchange
      .fetchTicker(symbol)
      .then((ticker) => enqueueTicker(ticker))
      .catch((error) => app.log.warn({ err: error, symbol }, "24h ticker stats refresh failed"));
  }
}, TICKER_STATS_REFRESH_MS);

const authSweepTimer = setInterval(() => auth.sweep(), AUTH_SWEEP_MS);

function enqueueTicker(ticker: Ticker) {
  tickerQueue = tickerQueue
    .then(() => handleTicker(ticker))
    .catch((error) => app.log.warn({ err: error, symbol: ticker.symbol }, "ticker processing failed"));
}

async function handleTicker(ticker: Ticker) {
  const mergedTicker = mergeTicker(ticker);
  tickers.set(mergedTicker.symbol, mergedTicker);
  const tickerUpdate = await accountManager.updateTicker(mergedTicker);
  await botRuntime.onTicker(mergedTicker);
  for (const order of tickerUpdate.orders) {
    hub.broadcast({ type: "order", data: order });
  }
  hub.broadcast({ type: "tickers", data: Object.fromEntries(tickers) });
  const accountIds = [...new Set([...tickerUpdate.accountIds, ...hub.subscribedAccountIds()])];
  for (const accountId of accountIds) {
    try {
      hub.broadcastAccount(accountId, { type: "account", data: await accountManager.snapshotFor(accountId) });
    } catch (error) {
      app.log.warn({ err: error, accountId }, "account snapshot broadcast failed");
    }
  }
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
  if (!request.accountId) return rejectedOrder(request, "", "必须指定账户");
  const account = await prisma.account.findUnique({ where: { id: request.accountId } });
  if (!account || account.archivedAt) {
    return rejectedOrder(request, request.accountId ?? "", "账户不存在");
  }
  if (account.mode === "bot") {
    return rejectedOrder(request, account.id, "机器人账户不支持手动下单");
  }
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
    const now = Date.now();
    return {
      id: String(result.id),
      clientOrderId: request.clientOrderId,
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
      closeAmount: 0,
      closeFee: 0,
      closePnl: 0,
      margin: 0,
      status: Number(result.remaining ?? 0) > 0 ? "partial" as const : "filled" as const,
      accountId: account.id,
      createdAt: now,
      updatedAt: now,
      filledAt: Number(result.remaining ?? 0) > 0 ? undefined : now
    };
  }

  const order = await accountManager.executePaper({ ...request, accountId: account.id });
  hub.broadcast({ type: "order", data: order });
  hub.broadcastAccount(account.id, { type: "account", data: await accountManager.snapshotFor(account.id) });
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
  const now = Date.now();
  return {
    id: request.clientOrderId ?? "rejected-" + now,
    clientOrderId: request.clientOrderId,
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
    closeAmount: 0,
    closeFee: 0,
    closePnl: 0,
    margin: 0,
    status: "rejected" as const,
    accountId,
    reason,
    createdAt: now,
    updatedAt: now
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

function accountIdFromWsUrl(url: string) {
  const query = url.split("?")[1];
  if (!query) return undefined;
  return new URLSearchParams(query).get("accountId") ?? undefined;
}

for (const symbol of config.defaultSymbols) {
  exchange.fetchTicker(symbol).then((ticker) => {
    tickers.set(symbol, ticker);
    enqueueTicker(ticker);
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
