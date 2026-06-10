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
