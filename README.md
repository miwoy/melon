# 蜜瓜交易系统

独立的 TypeScript 量化交易系统 MVP，面向币安 U 本位永续合约市场，支持：

- `ccxt` 统一交易所适配
- 永续合约模拟盘撮合与账户、仓位、订单账本
- 杠杆、保证金、手续费、市价单、限价单
- 多账户：模拟账户和真实账户分离，前端本地选择当前账户
- SQLite 持久化账户、持仓、订单、平仓事件和机器人参数
- 机器人账户抽象，当前内置随机交易机器人
- WebSocket 行情和账户状态推送
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

常用检查命令：

```bash
npm test
npm run typecheck
npm run build
```

## 登录授权

后端支持通过 `APP_PASSWORD` 开启访问密码：

```env
APP_PASSWORD=你的访问密码
AUTH_TOKEN_TTL_SECONDS=43200
CORS_ORIGINS=https://melon.miwoes.com
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

## 机器人开发

策略交易以“机器人账户”的方式接入。机器人必须绑定一个账户，账户创建后按机器人类型加载参数并运行。当前内置随机交易机器人，后续新增网格、浮盈加仓、AI 辅助等策略时，应在 `backend/src/bots` 下实现机器人定义，并通过 `BotRegistry` 注册。

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
- 模拟撮合器会限制每个账户当前未完成限价委托数量，默认 `PAPER_MAX_OPEN_LIMIT_ORDERS=200`。

## 目录结构

```text
backend/src
├── broker              # 模拟盘账户、仓位和订单
├── exchange            # ccxt 交易所适配
├── market              # 币安原生 WebSocket 行情
├── bots                # 机器人抽象与具体机器人定义
├── ws                  # 前端事件推送
└── server.ts           # REST API 和服务装配
frontend/src
├── lib/api.ts          # REST 客户端
├── main.tsx            # 仪表盘
└── styles.css
shared
└── types.d.ts          # 前后端共享类型
```

## API

- `GET /api/symbols`
- `GET /api/accounts`
- `POST /api/accounts`
- `GET /api/accounts/:id/snapshot`
- `GET /api/tickers`
- `GET /api/account`
- `GET /api/account/stats`
- `POST /api/orders`
- `DELETE /api/orders/:id`
- `GET /api/orders/history`
- `GET /api/positions/history`
- `GET /api/bots/definitions`
- `POST /api/bots/stop`
- `GET /ws`

## 建议的下一阶段

- 增加 PostgreSQL 部署选项，支撑更高频的机器人交易和更长历史数据。
- 增加回测模块：复用机器人定义中的信号与风控逻辑，用历史 K 线驱动验证。
- 增加风控模块：最大下单金额、最大持仓、最大回撤、连续亏损暂停。
- 增加币安合约或杠杆适配时单独建执行器，不要和现货混用。
