import type { Account, Order as DbOrder, Position as DbPosition } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { PaperBroker } from "../broker/PaperBroker.js";
import type { AccountKind, AccountSnapshot, CreateOrderRequest, Order, Paginated, Position, Ticker, TradingAccount, UpdatePositionRiskRequest } from "../types.js";

type LoadedAccount = Account & {
  positions: DbPosition[];
  orders: DbOrder[];
};

const accountInclude = {
  positions: true,
  orders: { orderBy: { createdAt: "desc" as const }, take: 200 }
};

export class AccountManager {
  private activeAccountId = "";
  private readonly paperBrokers = new Map<string, PaperBroker>();

  async initialize() {
    const count = await prisma.account.count();
    if (count === 0) {
      await prisma.account.create({
        data: {
          name: "默认模拟账户",
          kind: "paper",
          cash: config.paperStartingCash,
          isActive: true
        }
      });
    }

    const accounts = await prisma.account.findMany({ include: accountInclude });
    const active = accounts.find((account) => account.isActive) ?? accounts[0];
    this.activeAccountId = active.id;
    for (const account of accounts) {
      if (account.kind === "paper") this.loadPaperBroker(account);
    }
  }

  async list(): Promise<TradingAccount[]> {
    const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
    return accounts.map((account) => ({
      id: account.id,
      name: account.name,
      kind: account.kind as AccountKind,
      isActive: account.id === this.activeAccountId,
      cash: account.cash,
      createdAt: account.createdAt.getTime()
    }));
  }

  async create(input: { name: string; kind: AccountKind; startingCash?: number }) {
    const account = await prisma.account.create({
      data: {
        name: input.name,
        kind: input.kind,
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
    await prisma.$transaction([
      prisma.account.updateMany({ data: { isActive: false } }),
      prisma.account.update({ where: { id: accountId }, data: { isActive: true } })
    ]);
    this.activeAccountId = accountId;
    if (account.kind === "paper" && !this.paperBrokers.has(account.id)) this.loadPaperBroker(account);
    return this.snapshot();
  }

  activeId() {
    return this.activeAccountId;
  }

  async activeAccount() {
    const account = await prisma.account.findUnique({ where: { id: this.activeAccountId } });
    if (!account) throw new Error("当前账户不存在");
    return account;
  }

  async snapshot(): Promise<AccountSnapshot> {
    const account = await this.activeAccount();
    if (account.kind === "paper") {
      const broker = this.paperBrokers.get(account.id);
      if (!broker) throw new Error("模拟账户未加载");
      return broker.snapshot();
    }
    return {
      accountId: account.id,
      accountName: account.name,
      accountKind: "live",
      cash: account.cash,
      equity: account.cash,
      usedMargin: 0,
      realizedPnl: account.realizedPnl,
      totalFees: account.totalFees,
      positions: [],
      orders: []
    };
  }

  async paginatedOrders(input: { page: number; pageSize: number }): Promise<Paginated<Order>> {
    const accountId = this.activeAccountId;
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

  async paginatedPositionHistory(input: { page: number; pageSize: number }): Promise<Paginated<Position>> {
    const accountId = this.activeAccountId;
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
        orderBy: [{ closedAt: "desc" }, { updatedAt: "desc" }],
        skip: page * pageSize,
        take: pageSize
      })
    ]);
    return paginated(positions.map(deserializePosition), page, pageSize, total);
  }

  async updateTicker(ticker: Ticker): Promise<Order[]> {
    const changed: Order[] = [];
    for (const broker of this.paperBrokers.values()) {
      const filled = broker.updateTicker(ticker);
      changed.push(...filled);
    }
    for (const order of changed) {
      await this.persistPaperState(order.accountId);
    }
    return changed;
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
    const order = broker.execute({ ...request, accountId });
    await this.persistPaperState(accountId);
    return order;
  }

  async cancelPaperOrder(orderId: string) {
    const broker = this.paperBrokers.get(this.activeAccountId);
    if (!broker) throw new Error("模拟账户不存在");
    const order = broker.cancelOrder(orderId);
    if (!order) throw new Error("委托不存在或不可取消");
    await this.persistPaperState(order.accountId);
    return order;
  }

  async updatePaperPositionRisk(input: UpdatePositionRiskRequest) {
    const broker = this.paperBrokers.get(this.activeAccountId);
    if (!broker) throw new Error("模拟账户不存在");
    const position = broker.updatePositionRisk(input.positionId, input);
    if (!position) throw new Error("仓位不存在");
    await this.persistPaperState(this.activeAccountId);
    return this.snapshot();
  }

  async persistPaperState(accountId: string) {
    const broker = this.paperBrokers.get(accountId);
    if (!broker) return;
    const snapshot = broker.snapshot();
    await prisma.$transaction(async (tx) => {
      await tx.account.update({
        where: { id: accountId },
        data: {
          cash: broker.persistenceCash(),
          realizedPnl: broker.persistenceRealizedPnl(),
          totalFees: snapshot.totalFees
        }
      });
      await tx.position.deleteMany({ where: { accountId } });
      for (const position of broker.persistencePositions()) {
        await tx.position.create({ data: position });
      }
      for (const order of broker.persistenceOrders()) {
        await tx.order.upsert({
          where: { id: order.id },
          update: serializeOrder(order),
          create: serializeOrder(order)
        });
      }
    });
  }

  private loadPaperBroker(account: LoadedAccount) {
    const broker = new PaperBroker(account.id, account.name, account.cash, {
      maker: config.paperMakerFeeRate,
      taker: config.paperTakerFeeRate,
      limitFillRatio: config.paperLimitFillRatio
    });
    broker.load({
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
    margin: order.margin,
    status: order.status,
    reason: order.reason,
    createdAt: new Date(order.createdAt)
  };
}

function deserializeOrder(order: DbOrder): Order {
  return {
    id: order.id,
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
    margin: order.margin,
    status: order.status as Order["status"],
    reason: order.reason ?? undefined,
    createdAt: order.createdAt.getTime()
  };
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
