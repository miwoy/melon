# 随机策略机器人账户需求文档

## 背景

当前系统已经支持模拟账户、手动交易、仓位/委托展示、平仓事件统计。下一阶段要引入策略交易，但策略交易不应塞进手动交易流程，而应作为独立的机器人账户能力接入。

机器人账户的核心思想是：账户本身就是交易主体。手动账户显示手动交易功能；机器人账户绑定一个策略，只展示机器人状态、参数、仓位、挂单和终止操作，不提供手动下单入口。

## 目标

第一版只实现随机策略机器人账户，作为后续 AI 辅助策略、浮盈加仓、网格策略的基础。

目标包括：

- 创建账户时可选择手动账户或机器人账户。
- 机器人账户必须绑定策略类型。
- 第一版策略类型为随机策略。
- 机器人账户不显示手动交易卡片。
- 机器人账户展示策略参数、运行状态、当前仓位、当前委托、账户统计。
- 用户可以终止机器人。
- 随机策略可以自动开仓，并通过止盈止损或最大回撤规则自动结束/停止。
- 机器人下单必须复用当前交易核心能力，不能直接改订单、仓位或账户余额。

## 非目标

第一版不做：

- 真实账户机器人交易。
- AI 信号采集。
- 网格策略。
- 浮盈加仓策略。
- 多策略绑定同一账户。
- 策略市场或外部插件加载。
- 复杂回测系统。

## 账户模型

账户保留两个维度：

- `kind`: `paper` 或 `live`
- `mode`: `manual` 或 `bot`

第一版支持：

- `paper + manual`
- `paper + bot`

暂不支持：

- `live + bot`

机器人账户需要额外字段：

```ts
type BotAccountFields = {
  mode: "bot";
  strategyType: "random";
  botStatus: "running" | "stopped" | "ended";
  botConfig: RandomStrategyConfig;
  botState: RandomStrategyState;
  startedAt?: number;
  stoppedAt?: number;
  stopReason?: string;
};
```

普通手动账户：

```ts
type ManualAccountFields = {
  mode: "manual";
  strategyType?: undefined;
  botStatus?: undefined;
  botConfig?: undefined;
  botState?: undefined;
};
```

## 随机策略配置

随机策略的第一版配置：

```ts
type RandomStrategyConfig = {
  symbol: string;
  direction: "long" | "short" | "both";
  amount: number;
  amountUnit: "base" | "quote";
  leverage: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  maxDrawdownPercent: number;
  entryIntervalSeconds: number;
};
```

字段说明：

- `symbol`: 交易对。
- `direction`: 随机方向范围。
- `amount`: 每次开仓数量。
- `amountUnit`: 币数量或 USDT 金额。
- `leverage`: 杠杆倍数。
- `takeProfitPercent`: 基于开仓均价计算止盈价。
- `stopLossPercent`: 基于开仓均价计算止损价。
- `maxDrawdownPercent`: 基于平仓事件资金曲线的最大回撤阈值，超过后机器人结束。
- `entryIntervalSeconds`: 平仓后等待多久允许下一次随机开仓。

## 随机策略状态

```ts
type RandomStrategyState = {
  phase: "waiting" | "holding" | "ended";
  activePositionId?: string;
  lastEntryAt?: number;
  lastExitAt?: number;
  tradeCount: number;
};
```

状态含义：

- `waiting`: 当前没有持仓，等待下一次随机开仓。
- `holding`: 当前有策略仓位，等待止盈止损或强平。
- `ended`: 策略已结束，不再开仓。

## 策略执行逻辑

随机策略由机器人运行时调度。

触发来源：

- 行情更新。
- 订单成交。
- 仓位变化。
- 服务启动后恢复。

执行流程：

1. 如果机器人不是 `running`，不执行。
2. 读取绑定账户的当前仓位、委托、统计。
3. 检查最大回撤，超过阈值则结束机器人。
4. 如果没有持仓且等待时间已满足，随机选择方向并市价开仓。
5. 开仓成交后，根据成交均价设置止盈止损。
6. 如果已有持仓，不重复开仓。
7. 持仓平掉后，状态回到 `waiting`，等待下一轮。

## 止盈止损

随机策略使用百分比止盈止损。

做多：

```text
止盈价 = 开仓均价 * (1 + takeProfitPercent)
止损价 = 开仓均价 * (1 - stopLossPercent)
```

做空：

```text
止盈价 = 开仓均价 * (1 - takeProfitPercent)
止损价 = 开仓均价 * (1 + stopLossPercent)
```

止盈止损继续复用当前仓位风险设置能力。

## 最大回撤

第一版使用已结算资金曲线计算最大回撤。

数据来源：

- `AccountEquityEvent.equity`

如果最大回撤超过 `maxDrawdownPercent`：

1. 设置 `botStatus = ended`。
2. 设置 `stopReason = "最大回撤触发"`。
3. 取消机器人未成交委托。
4. 是否立即平仓：第一版建议不自动平仓，后续可增加配置。

## 终止机器人

用户在机器人账户页面只能执行终止机器人。

第一版终止行为：

1. 设置 `botStatus = stopped`。
2. 取消机器人当前未成交委托。
3. 保留已有仓位。
4. 前端提示用户仓位仍需关注。

后续可扩展：

```ts
type StopAction = "stop_only" | "cancel_orders" | "cancel_and_close";
```

## 订单和统计关联

机器人订单必须记录：

```ts
strategyType: "random";
botAccountId: string;
```

如果后续支持同一账户多机器人，则增加：

```ts
strategyInstanceId: string;
```

第一版由于一个机器人账户只有一个策略，可以先使用 `accountId + mode + strategyType` 关联。

平仓统计继续使用现有账户平仓事件：

- 资金曲线
- 最大回撤
- 胜率
- 手续费占比

## 前端行为

创建账户弹窗增加：

- 账户模式：手动账户 / 机器人账户。
- 机器人账户选择策略类型。
- 随机策略参数表单。

进入手动账户：

- 显示实时行情。
- 显示手动交易。
- 显示当前仓位/当前委托。
- 显示历史和账户统计。

进入机器人账户：

- 不显示手动交易卡片。
- 显示机器人状态卡片。
- 显示策略参数。
- 显示当前仓位/当前委托。
- 显示账户统计。
- 显示终止机器人按钮。

移动端也保持这个规则：机器人账户优先展示状态、仓位和委托。

## 后端模块建议

新增模块：

```text
backend/src/bots/
  BotRuntime.ts
  BotRegistry.ts
  BotContext.ts
  strategies/
    RandomStrategy.ts
```

职责：

- `BotRuntime`: 调度所有运行中的机器人账户。
- `BotRegistry`: 注册策略类型。
- `BotContext`: 提供统一交易核心接口。
- `RandomStrategy`: 随机策略逻辑。

策略不能直接访问 Prisma 修改订单/仓位，只能通过上下文调用：

```ts
ctx.placeOrder(...)
ctx.cancelOrder(...)
ctx.updatePositionRisk(...)
ctx.getAccountSnapshot()
ctx.getStats()
ctx.stopBot(reason)
```

## 数据库变更草案

`Account` 增加：

```prisma
mode         String  @default("manual")
strategyType String?
botStatus   String?
botConfig   Json?
botState    Json?
startedAt   DateTime?
stoppedAt   DateTime?
stopReason  String?
```

如果 SQLite/Prisma JSON 支持出现问题，可用 `String` 存 JSON 文本。

## 分阶段计划

### 阶段 1：数据模型和前端账户创建

- 增加账户模式字段。
- 创建账户支持手动/机器人。
- 机器人账户支持随机策略配置。
- 前端根据账户模式切换页面展示。

### 阶段 2：机器人运行时骨架

- 增加 `BotRuntime`。
- 服务启动加载 running bot。
- 行情更新时触发机器人。
- 机器人状态持久化。

### 阶段 3：随机策略交易

- 无仓位时随机开仓。
- 开仓后设置止盈止损。
- 平仓后回到等待状态。
- 统计最大回撤，触发结束。

### 阶段 4：终止和安全边界

- 前端终止机器人。
- 后端停止机器人。
- 取消未成交委托。
- 写入停止原因。

### 阶段 5：验证

- 类型检查。
- 构建。
- 本地模拟账户随机策略手动触发测试。
- 部署前确认手动账户逻辑不受影响。

## 开放问题

- 机器人终止时是否默认平仓？第一版建议不默认平仓。
- 随机策略是“平仓后必定再次开仓”，还是按概率开仓？第一版建议必定开仓，但受 `entryIntervalSeconds` 控制。
- 最大回撤触发后是否平仓？第一版建议只停止开新仓并取消委托。
- 机器人账户是否允许手动调整止盈止损？第一版建议不允许，避免打破策略状态。
