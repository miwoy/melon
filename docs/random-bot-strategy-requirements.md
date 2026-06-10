# 随机交易机器人账户需求文档

## 背景

当前系统已经支持模拟账户、手动交易、仓位/委托展示、平仓事件统计。下一阶段要引入策略交易，但策略交易不应塞进手动交易流程，而应作为独立的机器人账户能力接入。

机器人账户的核心思想是：账户本身就是交易主体。手动账户显示手动交易功能；机器人账户绑定一个机器人类型，只展示机器人状态、参数、仓位、挂单和终止操作，不提供手动下单入口。

在本系统里，“机器人”和“策略”统一为同一个概念：不同类型的机器人就是不同策略。比如随机交易机器人、AI 辅助机器人、网格机器人、浮盈加仓机器人。用户在前端看到的是机器人，后端实现上通过机器人类型注册不同策略逻辑。

## 目标

第一版先实现机器人抽象层，再实现随机交易机器人，作为后续 AI 辅助机器人、浮盈加仓机器人、网格机器人的基础。

目标包括：

- 创建账户时可选择手动账户或机器人账户。
- 机器人账户必须绑定机器人类型。
- 第一版机器人类型为随机交易机器人。
- 机器人账户不显示手动交易卡片。
- 机器人账户展示机器人参数、运行状态、当前仓位、当前委托、账户统计。
- 用户可以终止机器人。
- 随机交易机器人可以自动开仓，并通过止盈止损或最大回撤规则自动结束/停止。
- 机器人下单必须复用当前交易核心能力，不能直接改订单、仓位或账户余额。
- 机器人抽象层必须先于具体随机交易逻辑实现，避免第一版把随机策略写死进账户或交易核心。

## 非目标

第一版不做：

- 真实账户机器人交易。
- AI 信号采集。
- 网格机器人。
- 浮盈加仓机器人。
- 多策略绑定同一账户。
- 机器人市场或外部插件加载。
- 复杂回测系统。

## 机器人抽象层

机器人抽象层是第一阶段的核心。随机交易机器人只是一个插件式实现，不能让账户、订单、前端表单直接依赖随机策略细节。

统一概念：

- `botType`: 机器人类型，等价于策略类型。
- `BotDefinition`: 机器人定义，描述该机器人需要哪些配置、如何初始化状态、如何响应行情/订单/仓位变化。
- `BotAccount`: 绑定了机器人定义和配置的账户。
- `BotRuntime`: 机器人运行时，负责调度所有运行中的机器人账户。
- `BotContext`: 机器人访问交易核心的唯一接口。

机器人定义接口草案：

```ts
type BotType = "random";

type BotDefinition<TConfig, TState> = {
  type: BotType;
  name: string;
  description: string;
  configSchema: BotConfigField[];
  createInitialState(config: TConfig): TState;
  onStart?(ctx: BotContext<TConfig, TState>): Promise<void>;
  onTick(ctx: BotContext<TConfig, TState>): Promise<void>;
  onOrderUpdate?(ctx: BotContext<TConfig, TState>, order: Order): Promise<void>;
  onPositionUpdate?(ctx: BotContext<TConfig, TState>, position: Position): Promise<void>;
  onStop?(ctx: BotContext<TConfig, TState>, reason: string): Promise<void>;
};
```

机器人运行时只认识 `BotDefinition`，不关心具体是随机、网格还是 AI。新增机器人类型时，只需要注册新的定义。

机器人上下文接口草案：

```ts
type BotContext<TConfig, TState> = {
  accountId: string;
  config: TConfig;
  state: TState;
  now: number;
  getAccountSnapshot(): Promise<AccountSnapshot>;
  getStats(): Promise<AccountStats>;
  placeOrder(input: CreateOrderRequest): Promise<Order>;
  cancelOrder(orderId: string): Promise<Order>;
  updatePositionRisk(input: UpdatePositionRiskRequest): Promise<AccountSnapshot>;
  updateState(nextState: TState): Promise<void>;
  stop(reason: string): Promise<void>;
  log(message: string, data?: unknown): Promise<void>;
};
```

机器人必须通过 `BotContext` 操作交易核心。禁止机器人直接改 Prisma 里的订单、仓位、账户余额。

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
  botType: "random";
  botStatus: "running" | "stopped" | "ended";
  botConfig: RandomBotConfig;
  botState: RandomBotState;
  startedAt?: number;
  stoppedAt?: number;
  stopReason?: string;
};
```

普通手动账户：

```ts
type ManualAccountFields = {
  mode: "manual";
  botType?: undefined;
  botStatus?: undefined;
  botConfig?: undefined;
  botState?: undefined;
};
```

## 随机交易机器人配置

随机交易机器人的第一版配置：

```ts
type RandomBotConfig = {
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

## 随机交易机器人状态

```ts
type RandomBotState = {
  phase: "waiting" | "holding" | "ended";
  activePositionId?: string;
  lastEntryAt?: number;
  lastExitAt?: number;
  tradeCount: number;
};
```

状态含义：

- `waiting`: 当前没有持仓，等待下一次随机开仓。
- `holding`: 当前有机器人仓位，等待止盈止损或强平。
- `ended`: 机器人已结束，不再开仓。

## 随机交易机器人执行逻辑

随机交易机器人由机器人运行时调度。

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

随机交易机器人使用百分比止盈止损。

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
botType: "random";
botAccountId: string;
```

如果后续支持同一账户多机器人，则增加：

```ts
strategyInstanceId: string;
```

第一版由于一个机器人账户只有一个机器人类型，可以先使用 `accountId + mode + botType` 关联。

平仓统计继续使用现有账户平仓事件：

- 资金曲线
- 最大回撤
- 胜率
- 手续费占比

## 前端行为

创建账户弹窗增加：

- 账户模式：手动账户 / 机器人账户。
- 机器人账户选择机器人类型。
- 随机交易机器人参数表单。

进入手动账户：

- 显示实时行情。
- 显示手动交易。
- 显示当前仓位/当前委托。
- 显示历史和账户统计。

进入机器人账户：

- 不显示手动交易卡片。
- 显示机器人状态卡片。
- 显示机器人参数。
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
  definitions/
    RandomBot.ts
```

职责：

- `BotRuntime`: 调度所有运行中的机器人账户。
- `BotRegistry`: 注册机器人类型。
- `BotContext`: 提供统一交易核心接口。
- `RandomBot`: 随机交易机器人逻辑。

机器人定义不能直接访问 Prisma 修改订单/仓位，只能通过上下文调用：

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
botType      String?
botStatus   String?
botConfig   Json?
botState    Json?
startedAt   DateTime?
stoppedAt   DateTime?
stopReason  String?
```

如果 SQLite/Prisma JSON 支持出现问题，可用 `String` 存 JSON 文本。

## 分阶段计划

### 阶段 1：机器人抽象层

- 增加 `backend/src/bots` 模块。
- 定义 `BotDefinition`、`BotContext`、`BotRegistry`、`BotRuntime`。
- 先注册空的随机交易机器人定义，但不急着自动交易。
- 后端提供机器人类型元信息接口，前端可据此渲染配置表单。

### 阶段 2：数据模型和前端账户创建

- 增加账户模式字段。
- 创建账户支持手动/机器人。
- 机器人账户支持机器人类型和配置。
- 前端根据账户模式切换页面展示。

### 阶段 3：机器人运行时骨架

- 增加 `BotRuntime`。
- 服务启动加载 running bot。
- 行情更新时触发机器人。
- 机器人状态持久化。

### 阶段 4：随机交易机器人

- 无仓位时随机开仓。
- 开仓后设置止盈止损。
- 平仓后回到等待状态。
- 统计最大回撤，触发结束。

### 阶段 5：终止和安全边界

- 前端终止机器人。
- 后端停止机器人。
- 取消未成交委托。
- 写入停止原因。

### 阶段 6：验证

- 类型检查。
- 构建。
- 本地模拟账户随机交易机器人手动触发测试。
- 部署前确认手动账户逻辑不受影响。

## 开放问题

- 机器人终止时是否默认平仓？第一版建议不默认平仓。
- 随机交易机器人是“平仓后必定再次开仓”，还是按概率开仓？第一版建议必定开仓，但受 `entryIntervalSeconds` 控制。
- 最大回撤触发后是否平仓？第一版建议只停止开新仓并取消委托。
- 机器人账户是否允许手动调整止盈止损？第一版建议不允许，避免打破策略状态。
