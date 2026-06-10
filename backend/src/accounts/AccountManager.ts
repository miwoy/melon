import type { Account, AccountEquityEvent as DbAccountEquityEvent, Order as DbOrder, Position as DbPosition } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { PaperBroker } from "../broker/PaperBroker.js";
import { randomBotDefinition } from "../bots/definitions/RandomBot.js";
import type { BotAccountRecord } from "../bots/types.js";
import type { AccountEquityEvent, AccountKind, AccountMode, AccountSnapshot, AccountStats, BotStatus, BotType, CreateOrderRequest, Order, Paginated, Position, RandomBotConfig, RandomBotState, Ticker, TradingAccount, UpdatePositionRiskRequest } from "../types.js";

type LoadedAccount = Account & {
  positions: DbPosition[];
  orders: DbOrder[];
};

const accountInclude = {
  positions: true,
  orders: {
    where: {
      type: "limit",
      status: { in: ["open", "partial"] }
    },
    orderBy: { createdAt: "desc" as const },
    take: config.paperMaxOpenLimitOrders
  }
};

export class AccountManager {
  private activeAccountId = "";
  private readonly paperBrokers = new Map<string, PaperBroker>();

  async initialize() {
    const count = await prisma.account.count({ where: { archivedAt: null } });
    if (count === 0) {
      await prisma.account.create({
        data: {
          name: "默认模拟账户",
          kind: "paper",
          mode: "manual",
          startingCash: config.paperStartingCash,
          cash: config.paperStartingCash,
          isActive: true
        }
      });
    }

    const accounts = await prisma.account.findMany({ where: { archivedAt: null }, include: accountInclude });
    const active = accounts.find((account) => account.isActive) ?? accounts[0];
    this.activeAccountId = active.id;
    if (!active.isActive) {
      await prisma.$transaction([
        prisma.account.updateMany({ data: { isActive: false } }),
        prisma.account.update({ where: { id: active.id }, data: { isActive: true } })
      ]);
    }
    for (const account of accounts) {
      if (account.kind === "paper") this.loadPaperBroker(account);
    }
  }

  async list(): Promise<TradingAccount[]> {
    const accounts = await prisma.account.findMany({ where: { archivedAt: null }, orderBy: { createdAt: "asc" } });
    return accounts.map((account) => ({
      id: account.id,
      name: account.name,
      kind: account.kind as AccountKind,
      mode: account.mode as AccountMode,
      botType: account.botType as BotType | undefined,
      botStatus: account.botStatus as BotStatus | undefined,
      botStartedAt: account.startedAt?.getTime(),
      botStoppedAt: account.stoppedAt?.getTime(),
      isActive: account.id === this.activeAccountId,
      cash: account.cash,
      createdAt: account.createdAt.getTime()
    }));
  }

  async create(input: { name: string; kind: AccountKind; mode?: AccountMode; botType?: BotType; botConfig?: RandomBotConfig; startingCash?: number }) {
    const mode = input.mode ?? "manual";
    const botConfig = mode === "bot" ? input.botConfig ?? randomBotDefinition.defaultConfig : undefined;
    const botState = mode === "bot" ? randomBotDefinition.createInitialState(botConfig ?? randomBotDefinition.defaultConfig) : undefined;
    const account = await prisma.account.create({
      data: {
        name: input.name,
        kind: input.kind,
        mode,
        botType: mode === "bot" ? input.botType ?? "random" : null,
        botStatus: mode === "bot" ? "running" : null,
        botConfig: botConfig ?? undefined,
        botState: botState ?? undefined,
        startedAt: mode === "bot" ? new Date() : null,
        startingCash: input.kind === "paper" ? input.startingCash ?? config.paperStartingCash : 0,
        cash: input.kind === "paper" ? input.startingCash ?? config.paperStartingCash : 0,
        isActive: false
      },
      include: accountInclude
    });
    if (account.kind === "paper") this.loadPaperBroker(account);
    return account;
  }

  async switch(accountId: string) {
    const account = await prisma.account.findUnique({ where: { id: accountId }, include: accountInclude });
    if (!account) throw new Error("账户不存在");
    if (account.archivedAt) throw new Error("账户已归档");
    this.activeAccountId = accountId;
    if (account.kind === "paper" && !this.paperBrokers.has(account.id)) this.loadPaperBroker(account);
    return this.snapshot();
  }

  async snapshot(): Promise<AccountSnapshot> {
    return this.snapshotFor(this.activeAccountId);
  }

  async snapshotFor(accountId: string): Promise<AccountSnapshot> {
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) throw new Error("账户不存在");
    if (account.archivedAt) throw new Error("账户已归档");
    if (account.kind === "paper") {
      const broker = this.paperBrokers.get(account.id);
      if (!broker) throw new Error("模拟账户未加载");
      return withAccountMeta(broker.snapshot(), account);
    }
    return {
      accountId: account.id,
      accountName: account.name,
      accountKind: "live",
      accountMode: account.mode as AccountMode,
      botType: account.botType as BotType | undefined,
      botStatus: account.botStatus as BotStatus | undefined,
      botConfig: parseBotConfig(account.botConfig),
      botState: parseBotState(account.botState),
      botStartedAt: account.startedAt?.getTime(),
      botStoppedAt: account.stoppedAt?.getTime(),
      stopReason: account.stopReason ?? undefined,
      cash: account.cash,
      equity: account.cash,
      usedMargin: 0,
      realizedPnl: account.realizedPnl,
      totalFees: account.totalFees,
      positions: [],
      orders: []
    };
  }

  async paginatedOrders(input: { accountId?: string; page: number; pageSize: number }): Promise<Paginated<Order>> {
    const accountId = input.accountId ?? this.activeAccountId;
    const page = Math.max(0, input.page);
    const pageSize = normalizePageSize(input.pageSize);
    const [total, orders] = await prisma.$transaction([
      prisma.order.count({ where: { accountId } }),
      prisma.order.findMany({
        where: { accountId },
        orderBy: { createdAt: "desc" },
        skip: page * pageSize,
        take: pageSize
      })
    ]);
    return paginated(orders.map(deserializeOrder), page, pageSize, total);
  }

  async paginatedPositionHistory(input: { accountId?: string; page: number; pageSize: number }): Promise<Paginated<Position>> {
    const accountId = input.accountId ?? this.activeAccountId;
    const page = Math.max(0, input.page);
    const pageSize = normalizePageSize(input.pageSize);
    const where = {
      accountId,
      OR: [{ status: "closed" }, { closedAmount: { gt: 0 } }]
    };
    const [total, positions] = await prisma.$transaction([
      prisma.position.count({ where }),
      prisma.position.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: page * pageSize,
        take: pageSize
      })
    ]);
    return paginated(positions.map(deserializePosition), page, pageSize, total);
  }

  async accountStats(accountId = this.activeAccountId): Promise<AccountStats> {
    const events = (await prisma.accountEquityEvent.findMany({
      where: { accountId },
      orderBy: { createdAt: "asc" }
    })).map(deserializeEquityEvent);
    const totalTrades = events.length;
    const wins = events.filter((event) => event.closePnl > 0).length;
    const totalPnl = events.reduce((sum, event) => sum + event.closePnl, 0);
    const totalFees = events.length ? events[events.length - 1].totalFees : 0;
    return {
      totalTrades,
      winRate: totalTrades > 0 ? wins / totalTrades : 0,
      totalPnl,
      totalFees,
      feeRatio: Math.abs(totalPnl) + totalFees > 0 ? totalFees / (Math.abs(totalPnl) + totalFees) : 0,
      maxDrawdown: maxDrawdown(events.map((event) => event.equity)),
      equityCurve: events,
      recentEvents: events.slice(-20).reverse()
    };
  }

  async updateTicker(ticker: Ticker): Promise<{ orders: Order[]; accountIds: string[] }> {
    const changed: Order[] = [];
    for (const broker of this.paperBrokers.values()) {
      const mutation = broker.runTransactional(() => broker.updateTicker(ticker));
      const filled = mutation.result;
      if (filled.length > 0) {
        try {
          await this.persistPaperState(filled[0].accountId);
        } catch (error) {
          mutation.rollback();
          throw error;
        }
      }
      changed.push(...filled);
    }
    const accountIds = [...new Set(changed.map((order) => order.accountId))];
    return { orders: changed, accountIds };
  }

  seedTickers(tickers: Ticker[]) {
    for (const broker of this.paperBrokers.values()) {
      for (const ticker of tickers) broker.updateTicker(ticker);
    }
  }

  async executePaper(request: CreateOrderRequest) {
    const accountId = request.accountId ?? this.activeAccountId;
    const broker = this.paperBrokers.get(accountId);
    if (!broker) throw new Error("模拟账户不存在");
    const mutation = broker.runTransactional(() => broker.execute({ ...request, accountId }));
    try {
      await this.persistPaperState(accountId);
      return mutation.result;
    } catch (error) {
      mutation.rollback();
      throw error;
    }
  }

  async cancelPaperOrderForAccount(accountId: string, orderId: string) {
    const broker = this.paperBrokers.get(accountId);
    if (!broker) throw new Error("模拟账户不存在");
    const mutation = broker.runTransactional(() => broker.cancelOrder(orderId));
    const order = mutation.result;
    if (!order) throw new Error("委托不存在或不可取消");
    try {
      await this.persistPaperState(order.accountId);
      return order;
    } catch (error) {
      mutation.rollback();
      throw error;
    }
  }

  async updatePaperPositionRiskForAccount(accountId: string, input: UpdatePositionRiskRequest) {
    const broker = this.paperBrokers.get(accountId);
    if (!broker) throw new Error("模拟账户不存在");
    const mutation = broker.runTransactional(() => broker.updatePositionRisk(input.positionId, input));
    const position = mutation.result;
    if (!position) throw new Error("仓位不存在");
    try {
      await this.persistPaperState(accountId);
      return this.snapshotFor(accountId);
    } catch (error) {
      mutation.rollback();
      throw error;
    }
  }

  async runningBotAccounts(symbol?: string): Promise<BotAccountRecord[]> {
    const accounts = await prisma.account.findMany({
      where: {
        kind: "paper",
        mode: "bot",
        botStatus: "running",
        archivedAt: null,
        botType: { not: null }
      }
    });
    return accounts
      .map((account) => ({
        id: account.id,
        name: account.name,
        botType: account.botType as BotType,
        botStatus: account.botStatus as BotStatus,
        botConfig: parseBotConfig(account.botConfig) ?? randomBotDefinition.defaultConfig,
        botState: parseBotState(account.botState) ?? randomBotDefinition.createInitialState(randomBotDefinition.defaultConfig),
        stopReason: account.stopReason ?? undefined
      }))
      .filter((account) => !symbol || account.botConfig.symbol === symbol);
  }

  async updateBotState(accountId: string, state: RandomBotState) {
    await prisma.account.update({
      where: { id: accountId },
      data: { botState: state }
    });
  }

  async stopBot(accountId: string, reason: string, status: BotStatus = "stopped") {
    const existing = await prisma.account.findUnique({ where: { id: accountId } });
    if (!existing) throw new Error("账户不存在");
    if (existing.mode !== "bot") throw new Error("当前账户不是机器人账户");

    const account = await prisma.account.update({
      where: { id: accountId },
      data: {
        botStatus: status,
        stoppedAt: new Date(),
        stopReason: reason
      }
    });
    const broker = this.paperBrokers.get(accountId);
    if (broker) {
      const mutation = broker.runTransactional(() => {
        for (const order of broker.snapshot().orders) {
          broker.cancelOrder(order.id);
        }
      });
      try {
        await this.persistPaperState(accountId);
      } catch (error) {
        mutation.rollback();
        throw error;
      }
    }
    return account;
  }

  async archiveAccount(accountId: string) {
    const account = await this.accountForRemoval(accountId);
    if (account.mode === "bot") {
      await this.stopAndCloseBotAccount(accountId, "账户已归档");
    } else {
      this.assertNoOpenPositions(accountId, "账户存在持仓，请先平仓后再归档");
    }
    await prisma.account.update({
      where: { id: accountId },
      data: {
        archivedAt: new Date(),
        isActive: false,
        botStatus: account.mode === "bot" ? "stopped" : account.botStatus,
        stoppedAt: account.mode === "bot" ? new Date() : account.stoppedAt,
        stopReason: account.mode === "bot" ? "账户已归档" : account.stopReason
      }
    });
    this.paperBrokers.delete(accountId);
    if (account.id === this.activeAccountId) await this.activateFallbackAccount(accountId);
    return this.snapshot();
  }

  async deleteAccount(accountId: string) {
    const account = await this.accountForRemoval(accountId);
    if (account.mode === "bot") {
      await this.stopAndCloseBotAccount(accountId, "账户已删除");
    } else {
      this.assertNoOpenPositions(accountId, "账户存在持仓，请先平仓后再删除");
    }
    await prisma.account.delete({ where: { id: accountId } });
    this.paperBrokers.delete(accountId);
    if (account.id === this.activeAccountId) await this.activateFallbackAccount(accountId);
    return this.snapshot();
  }

  async persistPaperState(accountId: string) {
    const broker = this.paperBrokers.get(accountId);
    if (!broker) return;
    const snapshot = broker.snapshot();
    const positions = broker.persistencePositions();
    const orders = broker.persistenceOrders();
    const persistedCash = broker.persistenceCash();
    const persistedRealizedPnl = broker.persistenceRealizedPnl();
    const persistedWalletBalance = broker.persistenceWalletBalance();
    assertAccountingClose(persistedWalletBalance, persistedCash + positions
      .filter((position) => position.status === "open" && position.amount > 0)
      .reduce((sum, position) => sum + position.margin, 0), "钱包余额");
    assertAccountingClose(persistedRealizedPnl, snapshot.realizedPnl, "已实现盈亏");
    await prisma.$transaction(async (tx) => {
      await tx.account.update({
        where: { id: accountId },
        data: {
          cash: persistedCash,
          realizedPnl: persistedRealizedPnl,
          totalFees: snapshot.totalFees
        }
      });
      for (const position of positions) {
        await tx.position.upsert({
          where: { id: position.id },
          update: position,
          create: position
        });
      }
      const closingOrderIds = orders.filter((order) => order.closeAmount > 0).map((order) => order.id);
      const existingEvents = new Map<string, { closeAmount: number; closePnl: number; fee: number }>();
      if (closingOrderIds.length > 0) {
        const events = await tx.accountEquityEvent.findMany({
          where: { accountId, orderId: { in: closingOrderIds } },
          select: { orderId: true, closeAmount: true, closePnl: true, fee: true }
        });
        for (const event of events) {
          const current = existingEvents.get(event.orderId) ?? { closeAmount: 0, closePnl: 0, fee: 0 };
          existingEvents.set(event.orderId, {
            closeAmount: current.closeAmount + event.closeAmount,
            closePnl: current.closePnl + event.closePnl,
            fee: current.fee + event.fee
          });
        }
      }
      for (const order of orders) {
        await tx.order.upsert({
          where: { id: order.id },
          update: serializeOrder(order),
          create: serializeOrder(order)
        });
        const recorded = existingEvents.get(order.id) ?? { closeAmount: 0, closePnl: 0, fee: 0 };
        if (order.closeAmount > recorded.closeAmount) {
          const event = serializeEquityEvent(order, snapshot, recorded);
          await tx.accountEquityEvent.create({ data: event });
          existingEvents.set(order.id, {
            closeAmount: order.closeAmount,
            closePnl: order.closePnl,
            fee: order.closeFee
          });
        }
      }
    });
  }

  private async accountForRemoval(accountId: string) {
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account || account.archivedAt) throw new Error("账户不存在");
    const visibleCount = await prisma.account.count({ where: { archivedAt: null } });
    if (visibleCount <= 1) throw new Error("至少需要保留一个账户");
    return account;
  }

  private async activateFallbackAccount(excludedAccountId: string) {
    const fallback = await prisma.account.findFirst({
      where: { id: { not: excludedAccountId }, archivedAt: null },
      orderBy: { createdAt: "asc" },
      include: accountInclude
    });
    if (!fallback) throw new Error("至少需要保留一个账户");
    await prisma.$transaction([
      prisma.account.updateMany({ data: { isActive: false } }),
      prisma.account.update({ where: { id: fallback.id }, data: { isActive: true } })
    ]);
    this.activeAccountId = fallback.id;
    if (fallback.kind === "paper" && !this.paperBrokers.has(fallback.id)) this.loadPaperBroker(fallback);
  }

  private async cancelOpenOrders(accountId: string) {
    const broker = this.paperBrokers.get(accountId);
    if (!broker) return;
    const mutation = broker.runTransactional(() => {
      for (const order of broker.snapshot().orders) {
        broker.cancelOrder(order.id);
      }
    });
    try {
      await this.persistPaperState(accountId);
    } catch (error) {
      mutation.rollback();
      throw error;
    }
  }

  private assertNoOpenPositions(accountId: string, message: string) {
    const broker = this.paperBrokers.get(accountId);
    if (!broker) return;
    if (broker.snapshot().positions.some((position) => position.status === "open" && position.amount > 0)) {
      throw new Error(message);
    }
  }

  private async stopAndCloseBotAccount(accountId: string, reason: string) {
    await prisma.account.update({
      where: { id: accountId },
      data: {
        botStatus: "stopped",
        stoppedAt: new Date(),
        stopReason: reason
      }
    });
    await this.cancelOpenOrders(accountId);
    await this.closeOpenPositions(accountId);
  }

  private async closeOpenPositions(accountId: string) {
    const broker = this.paperBrokers.get(accountId);
    if (!broker) return;
    const positions = broker.snapshot().positions.filter((position) => position.status === "open" && position.amount > 0);
    for (const position of positions) {
      const mutation = broker.runTransactional(() => broker.execute({
        accountId,
        symbol: position.symbol,
        side: position.side === "long" ? "sell" : "buy",
        type: "market",
        amount: position.amount,
        amountUnit: "base",
        leverage: position.leverage
      }));
      const order = mutation.result;
      try {
        await this.persistPaperState(accountId);
      } catch (error) {
        mutation.rollback();
        throw error;
      }
      if (order.status === "rejected") {
        throw new Error(`无法自动平仓 ${position.symbol}: ${order.reason ?? "下单失败"}`);
      }
    }
  }

  private loadPaperBroker(account: LoadedAccount) {
    const startingCash = account.startingCash || config.paperStartingCash;
    const broker = new PaperBroker(account.id, account.name, startingCash, {
      maker: config.paperMakerFeeRate,
      taker: config.paperTakerFeeRate,
      limitFillRatio: config.paperLimitFillRatio,
      maxOpenLimitOrders: config.paperMaxOpenLimitOrders
    });
    broker.load({
      startingCash,
      cash: account.cash,
      realizedPnl: account.realizedPnl,
      totalFees: account.totalFees,
      positions: account.positions.map((position) => {
        const side = position.side as "long" | "short";
        const entrySide = side === "long" ? "buy" : "sell";
        const entryOrder = account.orders
          .filter((order) => order.symbol === position.symbol && order.side === entrySide && order.status === "filled")
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
        return {
          id: position.id,
          symbol: position.symbol,
          base: position.base,
          quote: position.quote,
          side,
          status: position.status as "open" | "closed",
          signedAmount: position.signedAmount,
          amount: position.amount,
          openedAmount: position.openedAmount || position.amount,
          closedAmount: position.closedAmount,
          avgEntry: position.avgEntry || entryOrder?.price || 0,
          closeAvgPrice: position.closeAvgPrice ?? 0,
          markPrice: position.markPrice,
          marketValue: position.marketValue,
          liquidationPrice: 0,
          takeProfitPrice: position.takeProfitPrice ?? undefined,
          stopLossPrice: position.stopLossPrice ?? undefined,
          leverage: position.leverage,
          margin: position.margin,
          openedMargin: position.openedMargin || position.margin,
          realizedPnl: position.realizedPnl,
          unrealizedPnl: position.unrealizedPnl,
          fees: position.fees,
          netPnl: position.netPnl,
          roi: position.roi,
          openedAt: position.openedAt?.getTime() ?? position.updatedAt.getTime(),
          closedAt: position.closedAt?.getTime()
        };
      }),
      orders: account.orders.map(deserializeOrder)
    });
    this.paperBrokers.set(account.id, broker);
  }
}

function normalizePageSize(pageSize: number) {
  if (!Number.isFinite(pageSize)) return 10;
  return Math.min(Math.max(Math.trunc(pageSize), 1), 100);
}

function paginated<T>(items: T[], page: number, pageSize: number, total: number): Paginated<T> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  };
}

function serializeOrder(order: Order) {
  return {
    id: order.id,
    clientOrderId: order.clientOrderId,
    accountId: order.accountId,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    amount: order.amount,
    filledAmount: order.filledAmount,
    remainingAmount: order.remainingAmount,
    avgFillPrice: order.avgFillPrice,
    price: order.price,
    leverage: order.leverage,
    fee: order.fee,
    closeAmount: order.closeAmount,
    closeFee: order.closeFee,
    closePnl: order.closePnl,
    margin: order.margin,
    status: order.status,
    positionId: order.positionId,
    reason: order.reason,
    createdAt: new Date(order.createdAt),
    updatedAt: order.updatedAt ? new Date(order.updatedAt) : undefined,
    filledAt: order.filledAt ? new Date(order.filledAt) : undefined
  };
}

function deserializeOrder(order: DbOrder): Order {
  return {
    id: order.id,
    clientOrderId: order.clientOrderId ?? undefined,
    accountId: order.accountId,
    symbol: order.symbol,
    side: order.side as Order["side"],
    type: order.type as Order["type"],
    amount: order.amount,
    filledAmount: order.filledAmount || (order.status === "filled" ? order.amount : 0),
    remainingAmount: order.remainingAmount || (["open", "partial"].includes(order.status) ? Math.max(order.amount - order.filledAmount, 0) : 0),
    avgFillPrice: order.avgFillPrice || (order.status === "filled" ? order.price : 0),
    price: order.price,
    leverage: order.leverage,
    fee: order.fee,
    closeAmount: order.closeAmount ?? 0,
    closeFee: order.closeFee ?? 0,
    closePnl: order.closePnl ?? 0,
    margin: order.margin,
    status: order.status as Order["status"],
    positionId: order.positionId ?? undefined,
    reason: order.reason ?? undefined,
    createdAt: order.createdAt.getTime(),
    updatedAt: order.updatedAt?.getTime(),
    filledAt: order.filledAt?.getTime()
  };
}

function serializeEquityEvent(
  order: Order,
  snapshot: AccountSnapshot,
  recorded: { closeAmount: number; closePnl: number; fee: number }
) {
  const closeAmount = order.closeAmount - recorded.closeAmount;
  const closePnl = order.closePnl - recorded.closePnl;
  const fee = order.closeFee - recorded.fee;
  const eventTime = order.updatedAt ?? order.filledAt ?? Date.now();
  return {
    eventKey: `${order.id}:${order.filledAmount}:${order.closeAmount}`,
    accountId: order.accountId,
    orderId: order.id,
    positionId: order.positionId,
    symbol: order.symbol,
    side: order.side,
    closeAmount,
    closePrice: order.avgFillPrice || order.price,
    closePnl,
    fee,
    realizedPnl: snapshot.realizedPnl,
    equity: snapshot.equity,
    cash: snapshot.cash,
    totalFees: snapshot.totalFees,
    createdAt: new Date(eventTime)
  };
}

function deserializeEquityEvent(event: DbAccountEquityEvent): AccountEquityEvent {
  return {
    id: event.id,
    eventKey: event.eventKey,
    accountId: event.accountId,
    orderId: event.orderId,
    positionId: event.positionId ?? undefined,
    symbol: event.symbol,
    side: event.side as AccountEquityEvent["side"],
    closeAmount: event.closeAmount,
    closePrice: event.closePrice,
    closePnl: event.closePnl,
    fee: event.fee,
    realizedPnl: event.realizedPnl,
    equity: event.equity,
    cash: event.cash,
    totalFees: event.totalFees,
    createdAt: event.createdAt.getTime()
  };
}

function withAccountMeta(snapshot: AccountSnapshot, account: Account): AccountSnapshot {
  return {
    ...snapshot,
    accountMode: account.mode as AccountMode,
    botType: account.botType as BotType | undefined,
    botStatus: account.botStatus as BotStatus | undefined,
    botConfig: parseBotConfig(account.botConfig),
    botState: parseBotState(account.botState),
    botStartedAt: account.startedAt?.getTime(),
    botStoppedAt: account.stoppedAt?.getTime(),
    stopReason: account.stopReason ?? undefined
  };
}

function parseBotConfig(value: unknown): RandomBotConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const config = value as Partial<RandomBotConfig>;
  if (!config.symbol || !config.direction || !config.amount || !config.amountUnit || !config.leverage) return undefined;
  return {
    symbol: String(config.symbol),
    direction: config.direction === "long" || config.direction === "short" || config.direction === "both" ? config.direction : "both",
    amount: Number(config.amount),
    amountUnit: config.amountUnit === "base" ? "base" : "quote",
    leverage: Number(config.leverage),
    takeProfitPercent: Number(config.takeProfitPercent),
    stopLossPercent: Number(config.stopLossPercent),
    maxDrawdownPercent: Number(config.maxDrawdownPercent),
    entryIntervalSeconds: Number(config.entryIntervalSeconds)
  };
}

function parseBotState(value: unknown): RandomBotState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<RandomBotState>;
  return {
    phase: state.phase === "holding" || state.phase === "ended" ? state.phase : "waiting",
    activePositionId: state.activePositionId,
    lastEntryAt: state.lastEntryAt,
    lastExitAt: state.lastExitAt,
    tradeCount: Number(state.tradeCount ?? 0)
  };
}

function maxDrawdown(values: number[]) {
  let peak = values[0] ?? 0;
  let drawdown = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak > 0) drawdown = Math.max(drawdown, (peak - value) / peak);
  }
  return drawdown;
}

function assertAccountingClose(actual: number, expected: number, label: string) {
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(`${label}账务校验失败: actual=${actual}, expected=${expected}`);
  }
}

function deserializePosition(position: DbPosition): Position {
  return {
    id: position.id,
    symbol: position.symbol,
    base: position.base,
    quote: position.quote,
    side: position.side as Position["side"],
    status: position.status as Position["status"],
    amount: position.amount,
    openedAmount: position.openedAmount,
    closedAmount: position.closedAmount,
    avgEntry: position.avgEntry,
    closeAvgPrice: position.closeAvgPrice ?? 0,
    markPrice: position.markPrice,
    marketValue: position.marketValue,
    liquidationPrice: 0,
    takeProfitPrice: position.takeProfitPrice ?? undefined,
    stopLossPrice: position.stopLossPrice ?? undefined,
    leverage: position.leverage,
    margin: position.margin,
    openedMargin: position.openedMargin,
    realizedPnl: position.realizedPnl,
    unrealizedPnl: position.unrealizedPnl,
    fees: position.fees,
    netPnl: position.netPnl,
    roi: position.roi,
    openedAt: position.openedAt.getTime(),
    closedAt: position.closedAt?.getTime()
  };
}
