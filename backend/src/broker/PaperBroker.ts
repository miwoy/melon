import { nanoid } from "nanoid";
import type { AccountSnapshot, CreateOrderRequest, Order, Position, Ticker } from "../types.js";

type InternalPosition = Position & {
  signedAmount: number;
};

type FeeRates = {
  maker: number;
  taker: number;
  limitFillRatio: number;
};

type FillResult =
  | { ok: true; fee: number; margin: number; closeAmount: number; closeFee: number; closePnl: number; positionId?: string; filledAmount: number; avgFillPrice: number }
  | { ok: false; reason: string };

type CrossAccountMetrics = {
  availableBalance: number;
  dynamicUsedMargin: number;
  equity: number;
  openUnrealizedPnl: number;
  walletBalance: number;
};

export class PaperBroker {
  private cash: number;
  private realizedPnl = 0;
  private totalFees = 0;
  private readonly positions = new Map<string, InternalPosition>();
  private readonly closedPositions: InternalPosition[] = [];
  private readonly orders: Order[] = [];
  private readonly tickers = new Map<string, Ticker>();

  constructor(
    private readonly accountId: string,
    private accountName: string,
    startingCash: number,
    private readonly feeRates: FeeRates
  ) {
    this.cash = startingCash;
  }

  load(state: { cash: number; realizedPnl: number; totalFees: number; positions: InternalPosition[]; orders: Order[] }) {
    this.cash = state.cash;
    const orderFees = state.orders
      .filter((order) => ["filled", "partial"].includes(order.status))
      .reduce((sum, order) => sum + order.fee, 0);
    const positionRealizedPnl = state.positions.reduce((sum, position) => sum + position.realizedPnl, 0);
    this.totalFees = orderFees || state.totalFees;
    this.realizedPnl = isClose(state.realizedPnl - this.totalFees, positionRealizedPnl)
      ? state.realizedPnl
      : positionRealizedPnl + this.totalFees;
    this.positions.clear();
    this.closedPositions.splice(0);
    for (const position of state.positions) {
      this.recalculate(position);
      if (position.status === "closed" || position.amount === 0) {
        this.closedPositions.push({ ...position, status: "closed", amount: 0, signedAmount: 0 });
      } else {
        this.positions.set(position.symbol, position);
      }
    }
    this.orders.splice(0, this.orders.length, ...state.orders);
  }

  rename(name: string) {
    this.accountName = name;
  }

  updateTicker(ticker: Ticker): Order[] {
    this.tickers.set(ticker.symbol, ticker);
    const position = this.positions.get(ticker.symbol);
    if (position) this.mark(position, ticker.last);

    const changed: Order[] = [];
    for (const order of this.orders) {
      if (!["open", "partial"].includes(order.status) || order.symbol !== ticker.symbol) continue;
      if (!this.shouldFillLimit(order, ticker.last)) continue;

      const remainingAmount = this.remainingAmount(order);
      if (remainingAmount <= 0) continue;
      const fillAmount = this.nextLimitFillAmount(order);
      const result = this.applyFill(
        {
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          amount: fillAmount,
          price: order.price,
          leverage: order.leverage,
          accountId: this.accountId
        },
        order.price,
        this.feeRates.maker
      );
      if (!result.ok) {
        order.status = "rejected";
        order.reason = result.reason;
        changedTimestamp(order);
        changed.push(order);
        continue;
      }

      this.applyOrderFill(order, result);
      changed.push(order);
    }
    changed.push(...this.triggerPositionRiskOrders(ticker.symbol));
    changed.push(...this.liquidateRiskyPositions());
    return changed;
  }

  execute(request: CreateOrderRequest): Order {
    if (request.clientOrderId) {
      const existing = this.orders.find((order) => order.clientOrderId === request.clientOrderId);
      if (existing) return existing;
    }
    const ticker = this.tickers.get(request.symbol);
    const normalized = this.normalizeOrderAmount(request, ticker?.last);
    if (!normalized.ok) return this.reject(request, normalized.reason);
    request = normalized.request;

    if (request.type === "limit") {
      if (!request.price) return this.reject(request, "限价单必须填写价格");
      if (!ticker || !this.shouldFillLimitRequest(request, ticker.last)) {
        const order = this.order(request, request.price, "open", 0, 0);
        this.pushOrder(order);
        return order;
      }
      return this.fillLimit(request, request.price, this.feeRates.taker);
    }

    if (!ticker?.last || !Number.isFinite(ticker.last)) {
      return this.reject(request, "暂无可用行情价格");
    }
    return this.fill(request, ticker.last, this.feeRates.taker);
  }

  cancelOrder(orderId: string): Order | null {
    const order = this.orders.find((item) => item.id === orderId);
    if (!order || order.type !== "limit" || !["open", "partial"].includes(order.status)) return null;
    order.status = "canceled";
    order.reason = "用户取消委托";
    changedTimestamp(order);
    return order;
  }

  updatePositionRisk(positionId: string, input: { takeProfitPrice?: number | null; stopLossPrice?: number | null }) {
    const position = [...this.positions.values()].find((item) => item.id === positionId);
    if (!position) return null;
    position.takeProfitPrice = positiveOrUndefined(input.takeProfitPrice);
    position.stopLossPrice = positiveOrUndefined(input.stopLossPrice);
    return position;
  }

  snapshot(): AccountSnapshot {
    const activePositions = [...this.positions.values()];
    const metrics = this.crossMetrics(activePositions);
    const positions = [...activePositions, ...this.closedPositions]
      .map((position) => this.snapshotPosition(position, activePositions, metrics.walletBalance))
      .map(({ signedAmount: _signedAmount, ...position }) => position);
    return {
      accountId: this.accountId,
      accountName: this.accountName,
      accountKind: "paper",
      accountMode: "manual",
      cash: metrics.availableBalance,
      equity: metrics.equity,
      usedMargin: metrics.dynamicUsedMargin,
      realizedPnl: this.realizedPnl - this.totalFees,
      totalFees: this.totalFees,
      positions,
      orders: this.orders.filter((order) => order.type === "limit" && ["open", "partial"].includes(order.status))
    };
  }

  persistenceCash() {
    return this.cash;
  }

  persistenceRealizedPnl() {
    return this.realizedPnl;
  }

  persistencePositions() {
    return [...this.positions.values(), ...this.closedPositions]
      .map((position) => ({
        id: position.id,
        accountId: this.accountId,
        symbol: position.symbol,
        base: position.base,
        quote: position.quote,
        side: position.side,
        status: position.status,
        signedAmount: position.signedAmount,
        amount: position.amount,
        openedAmount: position.openedAmount,
        closedAmount: position.closedAmount,
        avgEntry: position.avgEntry,
        closeAvgPrice: position.closeAvgPrice,
        markPrice: position.markPrice,
        marketValue: position.marketValue,
        takeProfitPrice: position.takeProfitPrice,
        stopLossPrice: position.stopLossPrice,
        leverage: position.leverage,
        margin: position.margin,
        openedMargin: position.openedMargin,
        realizedPnl: position.realizedPnl,
        unrealizedPnl: position.unrealizedPnl,
        fees: position.fees,
        netPnl: position.netPnl,
        roi: position.roi,
        openedAt: new Date(position.openedAt),
        closedAt: position.closedAt ? new Date(position.closedAt) : null
      }));
  }

  persistenceOrders() {
    return this.orders;
  }

  private applyFill(request: CreateOrderRequest, price: number, feeRate: number): FillResult {
    const [base, quote] = request.symbol.split("/");
    const existing = this.positions.get(request.symbol);
    let current = existing ?? this.createPosition(request.symbol, base, quote, request.leverage, price);

    const signedDelta = request.side === "buy" ? request.amount : -request.amount;
    const beforeAmount = current.signedAmount;
    const sameDirection = beforeAmount === 0 || Math.sign(beforeAmount) === Math.sign(signedDelta);

    let fee = 0;
    let marginChange = 0;
    let closeFilledAmount = 0;
    let closeFee = 0;
    let closePnl = 0;
    let positionId = current.id;

    if (sameDirection) {
      const openResult = this.openPosition(current, signedDelta, price, request.leverage, feeRate);
      if (!openResult.ok) return { ok: false, reason: openResult.reason };
      fee += openResult.fee;
      marginChange += openResult.margin;
    } else {
      const closeAmount = Math.min(Math.abs(beforeAmount), Math.abs(signedDelta));
      const closeResult = this.closePosition(current, closeAmount, price, feeRate);
      fee += closeResult.fee;
      closeFilledAmount += closeAmount;
      closeFee += closeResult.fee;
      closePnl += closeResult.pnl;
      marginChange -= closeResult.releasedMargin;

      const remainingDelta = signedDelta + Math.sign(beforeAmount) * closeAmount;
      if (Math.abs(remainingDelta) > 0) {
        this.finishPosition(current, price);
        current = this.createPosition(request.symbol, base, quote, request.leverage, price);
        positionId = positionId || current.id;
        const openResult = this.openPosition(current, remainingDelta, price, request.leverage, feeRate);
        if (!openResult.ok) return { ok: false, reason: openResult.reason };
        fee += openResult.fee;
        marginChange += openResult.margin;
      }
    }

    this.mark(current, price);
    if (current.amount > 0) {
      this.positions.set(request.symbol, current);
    } else {
      this.finishPosition(current, price);
    }

    return { ok: true, fee, margin: Math.max(marginChange, 0), closeAmount: closeFilledAmount, closeFee, closePnl, positionId, filledAmount: request.amount, avgFillPrice: price };
  }

  private fill(request: CreateOrderRequest, price: number, feeRate: number, id = orderId(request)): Order {
    const result = this.applyFill(request, price, feeRate);
    if (!result.ok) return this.reject(request, result.reason);
    const order = this.order(request, price, "filled", 0, 0, id);
    this.applyOrderFill(order, result);
    this.pushOrder(order);
    return order;
  }

  private fillLimit(request: CreateOrderRequest, price: number, feeRate: number): Order {
    const order = this.order(request, price, "open", 0, 0);
    const fillAmount = Math.min(request.amount, Math.max(this.limitFillRatio() * request.amount, 0));
    const result = this.applyFill({ ...request, amount: fillAmount }, price, feeRate);
    if (!result.ok) return this.reject(request, result.reason);
    this.applyOrderFill(order, result);
    this.pushOrder(order);
    return order;
  }

  private openPosition(position: InternalPosition, signedDelta: number, price: number, leverage: number, feeRate: number) {
    const amount = Math.abs(signedDelta);
    const notional = amount * price;
    const margin = notional / leverage;
    const fee = notional * feeRate;
    if (this.crossAvailableAfter(margin, fee) < 0) return { ok: false as const, reason: "模拟盘全仓可用余额不足" };

    const nextAbsAmount = Math.abs(position.signedAmount) + amount;
    position.avgEntry = (Math.abs(position.signedAmount) * position.avgEntry + notional) / nextAbsAmount;
    position.signedAmount += signedDelta;
    position.leverage = leverage;
    position.margin += margin;
    position.openedMargin += margin;
    position.openedAmount += amount;
    position.side = position.signedAmount >= 0 ? "long" : "short";
    position.status = "open";
    position.amount = Math.abs(position.signedAmount);
    this.cash -= margin + fee;
    this.totalFees += fee;
    position.fees += fee;
    position.realizedPnl -= fee;
    this.recalculate(position);
    return { ok: true as const, fee, margin };
  }

  private closePosition(position: InternalPosition, closeAmount: number, price: number, feeRate: number) {
    const direction = Math.sign(position.signedAmount);
    const notional = closeAmount * price;
    const fee = notional * feeRate;
    const pnl = (price - position.avgEntry) * closeAmount * direction;
    const releasedMargin = position.margin * (closeAmount / Math.abs(position.signedAmount));
    const closedAmountBefore = position.closedAmount;

    position.signedAmount -= direction * closeAmount;
    position.margin -= releasedMargin;
    position.closedAmount += closeAmount;
    position.closeAvgPrice = weightedAverage(position.closeAvgPrice, closedAmountBefore, price, closeAmount);
    position.realizedPnl += pnl - fee;
    position.fees += fee;
    position.amount = Math.abs(position.signedAmount);
    if (position.amount === 0) {
      position.margin = 0;
    }

    this.cash += releasedMargin + pnl - fee;
    this.totalFees += fee;
    this.realizedPnl += pnl;
    this.recalculate(position);
    return { fee, pnl: pnl - fee, releasedMargin };
  }

  private mark(position: InternalPosition, price: number) {
    position.side = position.signedAmount >= 0 ? "long" : "short";
    position.amount = Math.abs(position.signedAmount);
    position.markPrice = price;
    position.marketValue = position.amount * price;
    position.unrealizedPnl = position.status === "open" ? (price - position.avgEntry) * position.amount * Math.sign(position.signedAmount || 1) : 0;
    this.recalculate(position);
  }

  private createPosition(symbol: string, base: string, quote: string, leverage: number, price: number): InternalPosition {
    return {
      id: nanoid(),
      symbol,
      base,
      quote,
      side: "long",
      status: "open",
      signedAmount: 0,
      amount: 0,
      openedAmount: 0,
      closedAmount: 0,
      avgEntry: 0,
      closeAvgPrice: 0,
      markPrice: price,
      marketValue: 0,
      liquidationPrice: 0,
      takeProfitPrice: undefined,
      stopLossPrice: undefined,
      leverage,
      margin: 0,
      openedMargin: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      fees: 0,
      netPnl: 0,
      roi: 0,
      openedAt: Date.now()
    };
  }

  private finishPosition(position: InternalPosition, price: number) {
    this.positions.delete(position.symbol);
    position.status = "closed";
    position.signedAmount = 0;
    position.amount = 0;
    position.margin = 0;
    position.marketValue = 0;
    position.unrealizedPnl = 0;
    position.takeProfitPrice = undefined;
    position.stopLossPrice = undefined;
    position.markPrice = price;
    position.closedAt = position.closedAt ?? Date.now();
    this.recalculate(position);
    if (!this.closedPositions.some((item) => item.id === position.id)) {
      this.closedPositions.unshift(position);
    }
  }

  private recalculate(position: InternalPosition) {
    position.netPnl = position.realizedPnl + position.unrealizedPnl;
    position.roi = position.openedMargin > 0 ? position.netPnl / position.openedMargin : 0;
  }

  private shouldFillLimit(order: Order, markPrice: number) {
    return order.side === "buy" ? markPrice <= order.price : markPrice >= order.price;
  }

  private shouldFillLimitRequest(request: CreateOrderRequest, markPrice: number) {
    if (!request.price) return false;
    return request.side === "buy" ? markPrice <= request.price : markPrice >= request.price;
  }

  private normalizeOrderAmount(request: CreateOrderRequest, markPrice?: number):
    | { ok: true; request: CreateOrderRequest }
    | { ok: false; reason: string } {
    if (request.amountUnit !== "quote") return { ok: true, request };
    const referencePrice = request.type === "limit" ? request.price : markPrice;
    if (!referencePrice || !Number.isFinite(referencePrice)) {
      return { ok: false, reason: "使用 USDT 金额下单时需要可用价格" };
    }
    return { ok: true, request: { ...request, amount: request.amount / referencePrice, amountUnit: "base" } };
  }

  private positionsMargin() {
    return [...this.positions.values()].reduce((sum, position) => sum + position.margin, 0);
  }

  private dynamicInitialMargin(position: InternalPosition) {
    if (position.status !== "open") return 0;
    return position.marketValue / position.leverage;
  }

  private crossMetrics(activePositions = [...this.positions.values()]): CrossAccountMetrics {
    const walletBalance = this.cash + this.positionsMargin();
    const openUnrealizedPnl = activePositions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
    const dynamicUsedMargin = activePositions.reduce((sum, position) => sum + this.dynamicInitialMargin(position), 0);
    const equity = walletBalance + openUnrealizedPnl;
    return {
      availableBalance: equity - dynamicUsedMargin,
      dynamicUsedMargin,
      equity,
      openUnrealizedPnl,
      walletBalance
    };
  }

  private crossAvailableAfter(newMargin: number, fee: number) {
    const metrics = this.crossMetrics();
    return metrics.availableBalance - newMargin - fee;
  }

  private snapshotPosition(position: InternalPosition, activePositions: InternalPosition[], walletBalance: number): InternalPosition {
    if (position.status !== "open") return { ...position, liquidationPrice: 0 };
    return {
      ...position,
      margin: this.dynamicInitialMargin(position),
      liquidationPrice: this.liquidationPrice(position, activePositions, walletBalance)
    };
  }

  private liquidationPrice(position: InternalPosition, activePositions: InternalPosition[], walletBalance: number) {
    if (position.status !== "open" || position.amount <= 0 || position.avgEntry <= 0) return 0;
    const otherUnrealizedPnl = activePositions
      .filter((item) => item.id !== position.id)
      .reduce((sum, item) => sum + item.unrealizedPnl, 0);
    // Cross-margin estimate: liquidate when account equity falls to 20% of wallet funds,
    // while other positions keep competing for the same shared funds at their current PnL.
    const targetPositionPnl = walletBalance * 0.2 - walletBalance - otherUnrealizedPnl;
    const direction = position.side === "long" ? 1 : -1;
    const rawPrice = position.avgEntry + targetPositionPnl / (position.amount * direction);
    return Math.max(rawPrice, 0);
  }

  private liquidateRiskyPositions() {
    const changed: Order[] = [];
    let triggered = true;

    while (triggered) {
      triggered = false;
      const activePositions = [...this.positions.values()];
      const walletBalance = this.crossMetrics(activePositions).walletBalance;

      for (const position of activePositions) {
        if (!this.positions.has(position.symbol)) continue;
        if (!this.shouldLiquidate(position, activePositions, walletBalance)) continue;

        const order = this.forceClosePosition(position);
        changed.push(order, ...this.cancelOpenLimitOrders(position.symbol));
        triggered = true;
        break;
      }
    }

    return changed;
  }

  private triggerPositionRiskOrders(symbol: string) {
    const changed: Order[] = [];
    const position = this.positions.get(symbol);
    if (!position || position.status !== "open" || position.amount <= 0) return changed;
    const reason = this.positionRiskTriggerReason(position);
    if (!reason) return changed;
    const order = this.forceClosePosition(position, reason);
    changed.push(order, ...this.cancelOpenLimitOrders(symbol, `${reason}后自动取消未成交委托`));
    return changed;
  }

  private positionRiskTriggerReason(position: InternalPosition) {
    if (position.side === "long") {
      if (position.takeProfitPrice && position.markPrice >= position.takeProfitPrice) return "止盈触发";
      if (position.stopLossPrice && position.markPrice <= position.stopLossPrice) return "止损触发";
      return "";
    }
    if (position.takeProfitPrice && position.markPrice <= position.takeProfitPrice) return "止盈触发";
    if (position.stopLossPrice && position.markPrice >= position.stopLossPrice) return "止损触发";
    return "";
  }

  private shouldLiquidate(position: InternalPosition, activePositions: InternalPosition[], walletBalance: number) {
    const price = this.liquidationPrice(position, activePositions, walletBalance);
    if (price <= 0 || position.markPrice <= 0) return false;
    return position.side === "long" ? position.markPrice <= price : position.markPrice >= price;
  }

  private forceClosePosition(position: InternalPosition, reason = "爆仓强平") {
    const amount = position.amount;
    const price = position.markPrice;
    const side = position.side === "long" ? "sell" : "buy";
    const closeResult = this.closePosition(position, amount, price, this.feeRates.taker);
    this.finishPosition(position, price);

    const order = this.order(
      {
        symbol: position.symbol,
        side,
        type: "market",
        amount,
        price,
        leverage: position.leverage,
        amountUnit: "base",
        accountId: this.accountId
      },
      price,
      "filled",
      closeResult.fee,
      0
    );
    order.filledAmount = amount;
    order.remainingAmount = 0;
    order.avgFillPrice = price;
    order.closeAmount = amount;
    order.closeFee = closeResult.fee;
    order.closePnl = closeResult.pnl;
    order.positionId = position.id;
    order.reason = reason;
    this.pushOrder(order);
    return order;
  }

  private cancelOpenLimitOrders(symbol: string, reason = "爆仓后自动取消未成交委托") {
    const changed: Order[] = [];
    for (const order of this.orders) {
      if (order.symbol !== symbol || order.type !== "limit" || !["open", "partial"].includes(order.status)) continue;
      order.status = "canceled";
      order.reason = reason;
      changedTimestamp(order);
      changed.push(order);
    }
    return changed;
  }

  private remainingAmount(order: Order) {
    return Math.max((order.remainingAmount || order.amount - order.filledAmount), 0);
  }

  private nextLimitFillAmount(order: Order) {
    const remaining = this.remainingAmount(order);
    if (remaining <= 0) return 0;
    return Math.min(remaining, Math.max(order.amount * this.limitFillRatio(), Number.EPSILON));
  }

  private limitFillRatio() {
    if (!Number.isFinite(this.feeRates.limitFillRatio)) return 1;
    return Math.min(Math.max(this.feeRates.limitFillRatio, 0.01), 1);
  }

  private applyOrderFill(order: Order, result: Extract<FillResult, { ok: true }>) {
    const previousFilled = order.filledAmount || 0;
    const nextFilled = Math.min(order.amount, previousFilled + result.filledAmount);
    const weightedPrice = previousFilled * (order.avgFillPrice || 0) + result.filledAmount * result.avgFillPrice;
    order.filledAmount = nextFilled;
    order.remainingAmount = Math.max(order.amount - nextFilled, 0);
    order.avgFillPrice = nextFilled > 0 ? weightedPrice / nextFilled : 0;
    order.fee += result.fee;
    order.closeAmount += result.closeAmount;
    order.closeFee += result.closeFee;
    order.closePnl += result.closePnl;
    order.margin += result.margin;
    order.positionId = order.positionId ?? result.positionId;
    order.status = order.remainingAmount > 0 ? "partial" : "filled";
    changedTimestamp(order);
  }

  private reject(request: CreateOrderRequest, reason: string): Order {
    const order = { ...this.order(request, request.price ?? 0, "rejected", 0, 0), reason };
    this.pushOrder(order);
    return order;
  }

  private order(
    request: CreateOrderRequest,
    price: number,
    status: Order["status"],
    fee: number,
    margin: number,
    id = orderId(request)
  ): Order {
    return {
      id,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      amount: request.amount,
      filledAmount: 0,
      remainingAmount: status === "rejected" ? 0 : request.amount,
      avgFillPrice: 0,
      price,
      leverage: request.leverage,
      fee,
      closeAmount: 0,
      closeFee: 0,
      closePnl: 0,
      margin,
      status,
      accountId: this.accountId,
      createdAt: Date.now()
    };
  }

  private pushOrder(order: Order) {
    const index = this.orders.findIndex((item) => item.id === order.id);
    if (index >= 0) this.orders.splice(index, 1);
    this.orders.unshift(order);
  }
}

function changedTimestamp(order: Order) {
  order.createdAt = order.createdAt || Date.now();
}

function orderId(request: CreateOrderRequest) {
  return request.clientOrderId ?? nanoid();
}

function isClose(left: number, right: number) {
  return Math.abs(left - right) < 1e-8;
}

function positiveOrUndefined(value?: number | null) {
  return value && Number.isFinite(value) && value > 0 ? value : undefined;
}

function weightedAverage(currentAvg: number, currentAmount: number, nextPrice: number, nextAmount: number) {
  const totalAmount = currentAmount + nextAmount;
  if (totalAmount <= 0) return 0;
  return (currentAvg * currentAmount + nextPrice * nextAmount) / totalAmount;
}
