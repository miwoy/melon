# 蜜瓜交易系统

独立的 TypeScript 量化交易系统 MVP，面向币安 U 本位永续合约市场，支持：

- `ccxt` 统一交易所适配
- 永续合约模拟盘撮合与账户、仓位、订单账本
- 杠杆、保证金、手续费、市价单、限价单
- 多账户：模拟账户和真实账户分离，可切换当前账户
- SQLite 持久化账户、持仓、订单和策略配置
- 可插拔策略引擎
- WebSocket 行情、账户和策略状态推送
- React 前端账户与仓位看板

## 快速开始

```bash
npm install
cp backend/.env.example backend/.env
npm --workspace backend run db:generate
npm --workspace backend run db:init
npm run dev
```

前端默认运行在 `http://localhost:5173`，后端默认运行在 `http://localhost:4000`。

## 登录授权

后端支持通过 `APP_PASSWORD` 开启访问密码：

```env
APP_PASSWORD=你的访问密码
AUTH_TOKEN_TTL_SECONDS=43200
```

`APP_PASSWORD` 为空时不启用登录保护。启用后，前端只会把密码提交给后端换取临时授权密钥，之后请求和 WebSocket 使用该密钥授权；前端不会保存明文密码。

## 交易模式说明

系统里有两种账户：

- 模拟账户：只用真实合约市场行情计算成交、保证金、手续费和盈亏，不会向币安提交真实订单，适合打磨策略。
- 真实账户：会通过币安接口提交真实订单，会产生真实资产变化，目前默认受保护，需要配置 API key 才能启用。

下单不再选择“模式”，而是选择当前账户。当前账户是模拟账户就走模拟盘撮合，当前账户是真实账户就走真实盘执行器。

默认会创建一个模拟账户。真实盘相关代码已经隔离在执行器位置，后续接入前请务必：

1. 使用币安测试网或小额账户验证。
2. 给 API key 设置最小权限。
3. 增加风控：最大仓位、最大日亏、滑点限制、熔断、审计日志。

## 策略开发

当前内置 `MovingAverageCrossStrategy` 示例策略。你可以在 `backend/src/strategies` 中新增策略，只要实现 `Strategy` 接口即可。

## 模拟盘合约规则

- 买入：开多或平空。
- 卖出：开空或平多。
- 市价单：按当前最新价立即成交。
- 限价单：未触价时挂单，价格触发后自动成交。
- 保证金：按 `名义价值 / 杠杆倍数` 占用。
- 挂单手续费：按 `名义价值 * PAPER_MAKER_FEE_RATE` 收取，默认 `0.0002`，也就是 `0.02%`。
- 吃单手续费：按 `名义价值 * PAPER_TAKER_FEE_RATE` 收取，默认 `0.0005`，也就是 `0.05%`。
- 市价单按吃单计算；限价单如果提交后立刻成交按吃单计算，如果先挂单后触价成交按挂单计算。
- 当前采用单交易对净持仓模型，同一交易对不会同时保留多头和空头两条仓位。

## 目录结构

```text
backend/src
├── broker              # 模拟盘账户、仓位和订单
├── exchange            # ccxt 交易所适配
├── market              # 币安原生 WebSocket 行情
├── strategies          # 策略接口与示例策略
├── ws                  # 前端事件推送
└── server.ts           # REST API 和服务装配
frontend/src
├── lib/api.ts          # REST 客户端
├── main.tsx            # 仪表盘
└── styles.css
```

## API

- `GET /api/symbols`
- `GET /api/accounts`
- `POST /api/accounts`
- `PUT /api/accounts/active`
- `GET /api/tickers`
- `GET /api/account`
- `POST /api/orders`
- `GET /api/strategy`
- `PUT /api/strategy`
- `GET /ws`

## 建议的下一阶段

- 增加持久化：PostgreSQL/SQLite 记录订单、成交、净值曲线和策略参数。
- 增加回测模块：复用同一套 `Strategy` 接口，用历史 K 线驱动策略。
- 增加风控模块：最大下单金额、最大持仓、最大回撤、连续亏损暂停。
- 增加币安合约或杠杆适配时单独建执行器，不要和现货混用。
