import assert from "node:assert/strict";
import test from "node:test";
import { PaperBroker } from "./PaperBroker.js";

const feeRates = {
  maker: 0.0002,
  taker: 0.0005,
  limitFillRatio: 0.5,
  maxOpenLimitOrders: 1
};

test("反向开仓余额不足时回滚已执行的平仓变更", () => {
  const broker = new PaperBroker("account-1", "测试账户", 1_000, feeRates);
  broker.updateTicker({ symbol: "BTC/USDT", last: 1_000, ts: Date.now() });

  const opened = broker.execute({
    accountId: "account-1",
    symbol: "BTC/USDT",
    side: "buy",
    type: "market",
    amount: 0.5,
    leverage: 1,
    amountUnit: "base"
  });
  assert.equal(opened.status, "filled");

  const before = broker.snapshot();
  const rejected = broker.execute({
    accountId: "account-1",
    symbol: "BTC/USDT",
    side: "sell",
    type: "market",
    amount: 2,
    leverage: 1,
    amountUnit: "base"
  });
  const after = broker.snapshot();

  assert.equal(rejected.status, "rejected");
  assert.equal(after.positions[0]?.amount, before.positions[0]?.amount);
  assert.equal(after.positions[0]?.side, "long");
  assert.equal(after.cash, before.cash);
  assert.equal(after.equity, before.equity);
  assert.equal(after.totalFees, before.totalFees);
});

test("未完成限价委托达到上限时拒绝新增挂单", () => {
  const broker = new PaperBroker("account-1", "测试账户", 10_000, feeRates);
  broker.updateTicker({ symbol: "BTC/USDT", last: 1_000, ts: Date.now() });

  const first = broker.execute({
    accountId: "account-1",
    symbol: "BTC/USDT",
    side: "buy",
    type: "limit",
    amount: 1,
    price: 900,
    leverage: 1,
    amountUnit: "base"
  });
  const second = broker.execute({
    accountId: "account-1",
    symbol: "BTC/USDT",
    side: "buy",
    type: "limit",
    amount: 1,
    price: 800,
    leverage: 1,
    amountUnit: "base"
  });

  assert.equal(first.status, "open");
  assert.equal(second.status, "rejected");
  assert.match(second.reason ?? "", /未完成限价委托/);
  assert.equal(broker.snapshot().orders.length, 1);
});

test("加载历史净已实现盈亏时不重复扣减手续费", () => {
  const broker = new PaperBroker("account-1", "测试账户", 8_103.67, feeRates);
  broker.load({
    cash: 8_103.67,
    realizedPnl: 1_872.32,
    totalFees: 1_483.31,
    orders: [],
    positions: [{
      id: "position-1",
      symbol: "BTC/USDT",
      base: "BTC",
      quote: "USDT",
      side: "long",
      status: "open",
      signedAmount: 1,
      amount: 1,
      openedAmount: 1,
      closedAmount: 0.5,
      avgEntry: 10_000,
      closeAvgPrice: 12_000,
      markPrice: 10_000,
      marketValue: 10_000,
      liquidationPrice: 0,
      leverage: 10,
      margin: 1_000,
      openedMargin: 1_000,
      realizedPnl: 1_872.32,
      unrealizedPnl: 0,
      fees: 1_483.31,
      netPnl: 1_872.32,
      roi: 1.87232,
      openedAt: Date.now()
    }]
  });

  assert.ok(Math.abs(broker.snapshot().realizedPnl - 1_872.32) < 1e-8);
});

test("账户级已实现盈亏以现金账本为准并包含手续费", () => {
  const broker = new PaperBroker("account-1", "测试账户", 100_000, feeRates);
  broker.updateTicker({ symbol: "BTC/USDT", last: 10_000, ts: Date.now() });

  const open = broker.execute({
    accountId: "account-1",
    symbol: "BTC/USDT",
    side: "buy",
    type: "market",
    amount: 1,
    leverage: 10,
    amountUnit: "base"
  });
  assert.equal(open.status, "filled");
  assert.equal(broker.snapshot().realizedPnl, -5);

  broker.updateTicker({ symbol: "BTC/USDT", last: 11_000, ts: Date.now() });
  const close = broker.execute({
    accountId: "account-1",
    symbol: "BTC/USDT",
    side: "sell",
    type: "market",
    amount: 1,
    leverage: 10,
    amountUnit: "base"
  });

  assert.equal(close.status, "filled");
  assert.equal(broker.snapshot().realizedPnl, 989.5);
  assert.equal(broker.persistenceRealizedPnl(), 989.5);
  assert.equal(broker.snapshot().cash, 100_989.5);
  assert.equal(broker.snapshot().totalFees, 10.5);
});
