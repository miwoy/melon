import type { BotDefinition } from "../types.js";
import type { OrderSide, RandomBotConfig, RandomBotState } from "../../types.js";

export const randomBotDefinition: BotDefinition<RandomBotConfig, RandomBotState> = {
  type: "random",
  name: "随机交易机器人",
  description: "无持仓时随机选择方向开仓，成交后自动设置止盈止损，平仓后等待下一轮。",
  defaultConfig: {
    symbol: "BTC/USDT",
    direction: "both",
    amount: 100,
    amountUnit: "quote",
    leverage: 10,
    takeProfitPercent: 0.01,
    stopLossPercent: 0.1,
    maxDrawdownPercent: 0.2,
    entryIntervalSeconds: 30
  },
  configSchema: [
    { key: "symbol", label: "交易对", type: "symbol" },
    {
      key: "direction",
      label: "方向",
      type: "select",
      options: [
        { label: "随机多空", value: "both" },
        { label: "只做多", value: "long" },
        { label: "只做空", value: "short" }
      ]
    },
    { key: "amount", label: "下单数量", type: "number", min: 0 },
    {
      key: "amountUnit",
      label: "数量单位",
      type: "select",
      options: [
        { label: "USDT 金额", value: "quote" },
        { label: "币数量", value: "base" }
      ]
    },
    { key: "leverage", label: "杠杆倍数", type: "number", min: 1, max: 125 },
    { key: "takeProfitPercent", label: "每仓止盈", type: "percent", min: 0 },
    { key: "stopLossPercent", label: "每仓止损", type: "percent", min: 0 },
    { key: "maxDrawdownPercent", label: "最大回撤", type: "percent", min: 0 },
    { key: "entryIntervalSeconds", label: "再次开仓间隔秒数", type: "number", min: 0 }
  ],
  createInitialState: () => ({
    phase: "waiting",
    tradeCount: 0
  }),
  async onTick(ctx) {
    if (ctx.ticker.symbol !== ctx.config.symbol) return;

    const stats = await ctx.getStats();
    if (ctx.config.maxDrawdownPercent > 0 && stats.maxDrawdown >= ctx.config.maxDrawdownPercent) {
      await ctx.stop("最大回撤触发");
      return;
    }

    const snapshot = await ctx.getAccountSnapshot();
    const position = snapshot.positions.find((item) => item.status === "open" && item.symbol === ctx.config.symbol);
    if (position) {
      if (ctx.state.phase !== "holding" || ctx.state.activePositionId !== position.id) {
        await ctx.updateState({ ...ctx.state, phase: "holding", activePositionId: position.id });
      }
      return;
    }

    if (ctx.state.phase === "holding") {
      await ctx.updateState({ ...ctx.state, phase: "waiting", activePositionId: undefined, lastExitAt: ctx.now });
      return;
    }

    const lastExitAt = ctx.state.lastExitAt ?? 0;
    if (ctx.now - lastExitAt < ctx.config.entryIntervalSeconds * 1000) return;
    if (snapshot.orders.some((order) => order.symbol === ctx.config.symbol && ["open", "partial"].includes(order.status))) return;

    const side = randomOrderSide(ctx.config.direction);
    const order = await ctx.placeOrder({
      symbol: ctx.config.symbol,
      side,
      type: "market",
      amount: ctx.config.amount,
      amountUnit: ctx.config.amountUnit,
      leverage: ctx.config.leverage
    });
    if (order.status === "rejected") {
      await ctx.log("随机交易机器人开仓失败", { reason: order.reason });
      return;
    }

    const nextSnapshot = await ctx.getAccountSnapshot();
    const nextPosition = nextSnapshot.positions.find((item) => item.status === "open" && item.symbol === ctx.config.symbol);
    if (nextPosition) {
      await ctx.updatePositionRisk({
        positionId: nextPosition.id,
        takeProfitPrice: takeProfitPrice(nextPosition.avgEntry, nextPosition.side, ctx.config.takeProfitPercent),
        stopLossPrice: stopLossPrice(nextPosition.avgEntry, nextPosition.side, ctx.config.stopLossPercent)
      });
      await ctx.updateState({
        phase: "holding",
        activePositionId: nextPosition.id,
        lastEntryAt: ctx.now,
        lastExitAt: ctx.state.lastExitAt,
        tradeCount: ctx.state.tradeCount + 1
      });
    }
  }
};

function randomOrderSide(direction: RandomBotConfig["direction"]): OrderSide {
  if (direction === "long") return "buy";
  if (direction === "short") return "sell";
  return Math.random() >= 0.5 ? "buy" : "sell";
}

function takeProfitPrice(entry: number, side: "long" | "short", percent: number) {
  return side === "long" ? entry * (1 + percent) : entry * (1 - percent);
}

function stopLossPrice(entry: number, side: "long" | "short", percent: number) {
  return side === "long" ? entry * (1 - percent) : entry * (1 + percent);
}
