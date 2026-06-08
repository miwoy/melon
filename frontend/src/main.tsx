import { StrictMode, useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { Activity, Archive, BarChart3, CircleDollarSign, History, ListPlus, Send, WalletCards, X } from "lucide-react";
import { ApiError, api, getAuthToken, setAuthToken } from "./lib/api";
import type { AccountEquityEvent, AccountKind, AccountMode, AccountSnapshot, AccountStats, AmountUnit, BotDefinitionMeta, BotStatus, BotType, Order, OrderType, Paginated, Position, RandomBotConfig, Ticker, TradingAccount } from "./types";
import "./styles.css";

const emptyAccount: AccountSnapshot = {
  accountId: "",
  accountName: "加载中",
  accountKind: "paper",
  accountMode: "manual",
  cash: 0,
  equity: 0,
  usedMargin: 0,
  realizedPnl: 0,
  totalFees: 0,
  positions: [],
  orders: []
};

const PAGE_SIZE = 10;
const TAKER_FEE_RATE = 0.0005;
const defaultRandomBotConfig: RandomBotConfig = {
  symbol: "BTC/USDT",
  direction: "both",
  amount: 100,
  amountUnit: "quote",
  leverage: 10,
  takeProfitPercent: 0.01,
  stopLossPercent: 0.005,
  maxDrawdownPercent: 0.2,
  entryIntervalSeconds: 30
};
type ModalView = "history" | "account" | "close" | "risk" | "stats" | null;
type CloseMode = "partial" | "all";
type CurrentOrderItem =
  | { kind: "limit"; id: string; order: Order }
  | { kind: "takeProfit" | "stopLoss"; id: string; position: Position; triggerPrice: number };

function App() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [botDefinitions, setBotDefinitions] = useState<BotDefinitionMeta[]>([]);
  const [tickers, setTickers] = useState<Record<string, Ticker>>({});
  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [account, setAccount] = useState<AccountSnapshot>(emptyAccount);
  const [selectedSymbol, setSelectedSymbol] = useState("BTC/USDT");
  const [amount, setAmount] = useState("0.001");
  const [amountUnit, setAmountUnit] = useState<AmountUnit>("base");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [price, setPrice] = useState("");
  const [leverage, setLeverage] = useState("10");
  const [newAccountName, setNewAccountName] = useState("");
  const [newAccountKind, setNewAccountKind] = useState<AccountKind>("paper");
  const [newAccountMode, setNewAccountMode] = useState<AccountMode>("manual");
  const [newBotType, setNewBotType] = useState<BotType>("random");
  const [newBotConfig, setNewBotConfig] = useState<RandomBotConfig>(defaultRandomBotConfig);
  const [newAccountCash, setNewAccountCash] = useState("100000");
  const [connection, setConnection] = useState("连接中");
  const [modal, setModal] = useState<ModalView>(null);
  const [portfolioTab, setPortfolioTab] = useState<"positions" | "orders">("positions");
  const [historyTab, setHistoryTab] = useState<"positions" | "orders">("positions");
  const [closePosition, setClosePosition] = useState<Position | null>(null);
  const [closeAmount, setCloseAmount] = useState("");
  const [closePercent, setClosePercent] = useState(100);
  const [closeMode, setCloseMode] = useState<CloseMode>("partial");
  const [riskPosition, setRiskPosition] = useState<Position | null>(null);
  const [takeProfitPrice, setTakeProfitPrice] = useState("");
  const [stopLossPrice, setStopLossPrice] = useState("");
  const [authReady, setAuthReady] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");

  useEffect(() => {
    api.authStatus().then((status) => {
      setAuthorized(!status.required || Boolean(getAuthToken()));
      setAuthReady(true);
    }).catch(() => {
      setLoginError("无法连接后端服务");
      setAuthReady(true);
    });
  }, []);

  useEffect(() => {
    if (!authorized) return;
    Promise.all([api.symbols(), api.botDefinitions(), api.accounts(), api.tickers(), api.account()]).then(
      ([symbolsRes, botDefsRes, accountsRes, tickerRes, accountRes]) => {
        setSymbols(symbolsRes.symbols);
        setBotDefinitions(botDefsRes.items);
        const randomDef = botDefsRes.items.find((item) => item.type === "random");
        if (randomDef) setNewBotConfig({ ...randomDef.defaultConfig, symbol: symbolsRes.symbols[0] ?? randomDef.defaultConfig.symbol });
        setAccounts(accountsRes);
        setSelectedSymbol(symbolsRes.symbols[0] ?? "BTC/USDT");
        setTickers(tickerRes);
        setAccount(accountRes);
      }
    ).catch(handleAuthError);
  }, [authorized]);

  useEffect(() => {
    if (!authorized) return;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let stopped = false;

    const connect = () => {
      const token = getAuthToken();
      ws = new WebSocket(`${protocol}://${window.location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      ws.onopen = () => setConnection("实时连接");
      ws.onclose = (event) => {
        if (event.code === 1008) {
          setAuthToken("");
          setAuthorized(false);
          setLoginError("登录已过期，请重新登录");
          return;
        }
        setConnection("正在重连");
        if (!stopped) reconnectTimer = window.setTimeout(connect, 3000);
      };
      ws.onerror = () => {
        setConnection("连接异常");
        ws?.close();
      };
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as
            | { type: "tickers"; data: Record<string, Ticker> }
            | { type: "account"; data: AccountSnapshot }
            | { type: "order"; data: Order };
          if (message.type === "tickers") setTickers(message.data);
          if (message.type === "account") setAccount(message.data);
        } catch {
          setConnection("消息异常");
        }
      };
    };
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [authorized]);

  const tickerRows = useMemo(() => Object.values(tickers).sort((a, b) => a.symbol.localeCompare(b.symbol)), [tickers]);
  const openPositions = useMemo(() => account.positions.filter((position) => position.status === "open"), [account.positions]);
  const currentOrders = useMemo<CurrentOrderItem[]>(() => {
    const limitItems: CurrentOrderItem[] = account.orders
      .filter((order) => order.type === "limit" && ["open", "partial"].includes(order.status))
      .map((order) => ({ kind: "limit", id: order.id, order }));
    const riskItems = openPositions.flatMap((position): CurrentOrderItem[] => [
      ...(position.takeProfitPrice ? [{ kind: "takeProfit" as const, id: `${position.id}-take-profit`, position, triggerPrice: position.takeProfitPrice }] : []),
      ...(position.stopLossPrice ? [{ kind: "stopLoss" as const, id: `${position.id}-stop-loss`, position, triggerPrice: position.stopLossPrice }] : [])
    ]);
    return [...limitItems, ...riskItems].slice(0, 8);
  }, [account.orders, openPositions]);
  const selectedTicker = tickers[selectedSymbol];
  const isBotAccount = account.accountMode === "bot";
  const referencePrice = orderType === "limit" ? Number(price) : selectedTicker?.last;
  const numericAmount = Number(amount);
  const numericLeverage = Number(leverage);
  const validReferencePrice = Number.isFinite(referencePrice) && referencePrice > 0 ? referencePrice : 0;
  const estimatedBaseAmount = amountUnit === "quote" && validReferencePrice ? numericAmount / validReferencePrice : numericAmount;
  const maxNotional = numericLeverage > 0 ? Math.max(account.cash, 0) / (1 / numericLeverage + TAKER_FEE_RATE) : 0;
  const maxBaseAmount = validReferencePrice > 0 ? maxNotional / validReferencePrice : 0;
  const maxInputAmount = amountUnit === "quote" ? maxNotional : maxBaseAmount;
  const validationError = validateOrderInput({
    amount: numericAmount,
    leverage: numericLeverage,
    referencePrice: validReferencePrice,
    orderType,
    maxInputAmount
  });
  const canSubmit = !validationError;
  const amountInvalid = !Number.isFinite(numericAmount) || numericAmount <= 0 || (maxInputAmount > 0 && numericAmount > maxInputAmount);
  const leverageInvalid = !Number.isFinite(numericLeverage) || numericLeverage <= 0;
  const priceInvalid = orderType === "limit" && !validReferencePrice;

  async function submit(side: "buy" | "sell") {
    if (!canSubmit) return;
    try {
      const order = await api.order({
        symbol: selectedSymbol,
        side,
        type: orderType,
        amount: Number(amount),
        amountUnit,
        price: orderType === "limit" ? Number(price) : undefined,
        leverage: Number(leverage)
      });
      if (order.type === "limit" && ["open", "partial"].includes(order.status)) {
        setAccount((current) => ({ ...current, orders: [order, ...current.orders] }));
      }
    } catch (error) {
      handleAuthError(error);
    }
  }

  async function switchAccount(accountId: string) {
    try {
      const snapshot = await api.switchAccount(accountId);
      setAccount(snapshot);
      setAccounts((current) => current.map((item) => ({ ...item, isActive: item.id === accountId })));
    } catch (error) {
      handleAuthError(error);
    }
  }

  async function createAccount() {
    try {
      const created = await api.createAccount({
        name: newAccountName.trim() || (newAccountMode === "bot" ? "新的机器人账户" : newAccountKind === "paper" ? "新的模拟账户" : "新的真实账户"),
        kind: newAccountKind,
        mode: newAccountMode,
        botType: newAccountMode === "bot" ? newBotType : undefined,
        botConfig: newAccountMode === "bot" ? newBotConfig : undefined,
        startingCash: newAccountKind === "paper" ? Number(newAccountCash) : undefined
      });
      setAccounts((current) => [...current, created]);
      setNewAccountName("");
      setModal(null);
    } catch (error) {
      handleAuthError(error);
    }
  }

  function openCloseModal(position: Position, mode: CloseMode) {
    const percent = mode === "all" ? 100 : 50;
    setClosePosition(position);
    setCloseMode(mode);
    setClosePercent(percent);
    setCloseAmount(formatAmountInput(amountByPercent(position.amount, percent)));
    setModal("close");
  }

  function openRiskModal(position: Position) {
    setRiskPosition(position);
    setTakeProfitPrice(position.takeProfitPrice ? formatAmountInput(position.takeProfitPrice) : "");
    setStopLossPrice(position.stopLossPrice ? formatAmountInput(position.stopLossPrice) : "");
    setModal("risk");
  }

  function updateCloseAmount(value: string) {
    setCloseAmount(value);
    const nextAmount = Number(value);
    if (!closePosition || !Number.isFinite(nextAmount)) return;
    setClosePercent(clampPercent((nextAmount / closePosition.amount) * 100));
  }

  function updateClosePercent(percent: number) {
    if (!closePosition) return;
    const nextPercent = clampPercent(percent);
    setClosePercent(nextPercent);
    setCloseAmount(formatAmountInput(amountByPercent(closePosition.amount, nextPercent)));
  }

  async function executeClosePosition() {
    if (!closePosition) return;
    const parsedAmount = Number(closeAmount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > closePosition.amount) return;
    const finalAmount = parsedAmount >= closePosition.amount ? closePosition.amount : roundAmount(parsedAmount);
    try {
      await api.order({
        symbol: closePosition.symbol,
        side: closePosition.side === "long" ? "sell" : "buy",
        type: "market",
        amount: finalAmount,
        amountUnit: "base",
        leverage: closePosition.leverage
      });
      setAccount(await api.account());
      setModal(null);
      setClosePosition(null);
    } catch (error) {
      handleAuthError(error);
    }
  }

  async function savePositionRisk() {
    if (!riskPosition) return;
    try {
      const snapshot = await api.updatePositionRisk(riskPosition.id, {
        takeProfitPrice: parseOptionalPositive(takeProfitPrice),
        stopLossPrice: parseOptionalPositive(stopLossPrice)
      });
      setAccount(snapshot);
      setModal(null);
      setRiskPosition(null);
    } catch (error) {
      handleAuthError(error);
    }
  }

  async function cancelCurrentOrder(item: CurrentOrderItem) {
    try {
      if (item.kind === "limit") {
        await api.cancelOrder(item.order.id);
      } else {
        await api.updatePositionRisk(item.position.id, {
          takeProfitPrice: item.kind === "takeProfit" ? null : item.position.takeProfitPrice ?? null,
          stopLossPrice: item.kind === "stopLoss" ? null : item.position.stopLossPrice ?? null
        });
      }
      setAccount(await api.account());
    } catch (error) {
      handleAuthError(error);
    }
  }

  async function stopBot() {
    try {
      const snapshot = await api.stopBot();
      setAccount(snapshot);
      setAccounts((current) => current.map((item) => item.id === snapshot.accountId ? { ...item, botStatus: snapshot.botStatus } : item));
    } catch (error) {
      handleAuthError(error);
    }
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    setLoginError("");
    try {
      const session = await api.login(loginPassword);
      setAuthToken(session.token);
      setLoginPassword("");
      setAuthorized(true);
    } catch (error) {
      setLoginError(error instanceof ApiError && error.status === 401 ? "密码错误" : "登录失败");
    }
  }

  function handleAuthError(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      setAuthToken("");
      setAuthorized(false);
      setLoginError("登录已过期，请重新登录");
      return;
    }
    console.error(error);
  }

  if (!authReady) return <main><div className="login-card"><h1>蜜瓜交易系统</h1><p>正在检查授权状态</p></div></main>;
  if (!authorized) return <main className="login-page"><form className="login-card" onSubmit={login}><h1>蜜瓜交易系统</h1><p>请输入访问密码以继续</p><label>访问密码<input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} autoFocus /></label>{loginError && <div className="trade-error">{loginError}</div>}<button className="neutral" disabled={!loginPassword}>登录</button></form></main>;

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <h1>蜜瓜交易系统</h1>
          <p>币安 U 本位永续合约 · 模拟盘优先</p>
        </div>
        <div className="top-controls">
          <label className="account-switcher">当前账户<select value={account.accountId} onChange={(event) => switchAccount(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {accountKindLabel(item.kind)} · {accountModeLabel(item.mode, item.botStatus)}</option>)}</select></label>
          <button className="icon-button" onClick={() => setModal("account")} title="新增账户"><ListPlus size={18} /></button>
          <div className={`status ${connection === "实时连接" ? "live" : ""}`}><Activity size={16} />{connection}</div>
        </div>
      </header>

      <section className="metrics">
        <Metric className="account-metric" icon={<WalletCards />} label={`${account.accountName} · ${accountKindLabel(account.accountKind)} · ${accountModeLabel(account.accountMode, account.botStatus)}`} value={money(account.equity)} />
        <Metric icon={<CircleDollarSign />} label="可用余额" value={money(account.cash)} />
        <Metric icon={<Activity />} label="占用保证金" value={money(account.usedMargin)} />
        <Metric icon={<Activity />} label="已实现 PnL" value={money(account.realizedPnl)} tone={account.realizedPnl >= 0 ? "up" : "down"} />
        <Metric icon={<Archive />} label="累计手续费" value={money(account.totalFees)} />
      </section>
      <section className="account-actions">
        <button className="ghost" onClick={() => setModal("stats")}><BarChart3 size={16} />账户统计</button>
      </section>

      <section className="dashboard">
        <div className="panel market">
          <PanelHeader title="实时行情" />
          <div className="table-scroll">
            <table>
              <thead><tr><th>交易对</th><th>最新价</th><th>买一价</th><th>卖一价</th><th>24小时</th></tr></thead>
              <tbody>{tickerRows.map((ticker) => <tr key={ticker.symbol}><td>{ticker.symbol}</td><td>{money(ticker.last)}</td><td>{ticker.bid ? money(ticker.bid) : "-"}</td><td>{ticker.ask ? money(ticker.ask) : "-"}</td><td className={ticker.percentage && ticker.percentage >= 0 ? "up" : "down"}>{pct(ticker.percentage)}</td></tr>)}</tbody>
            </table>
          </div>
        </div>

        <div className="panel trade">
          {isBotAccount ? <BotAccountPanel account={account} onStop={stopBot} /> : <>
          <PanelHeader title="手动交易" />
          <label className="symbol-row">交易对<select value={selectedSymbol} onChange={(e) => setSelectedSymbol(e.target.value)}>{symbols.map((symbol) => <option key={symbol}>{symbol}</option>)}</select></label>
          <div className="trade-quote">
            <div><span>最新价</span><strong>{selectedTicker ? money(selectedTicker.last) : "-"}</strong></div>
            <div><span>买一价</span><strong>{selectedTicker?.bid ? money(selectedTicker.bid) : "-"}</strong></div>
            <div><span>卖一价</span><strong>{selectedTicker?.ask ? money(selectedTicker.ask) : "-"}</strong></div>
            <div><span>24小时</span><strong className={selectedTicker?.percentage && selectedTicker.percentage >= 0 ? "up" : "down"}>{pct(selectedTicker?.percentage)}</strong></div>
          </div>
          <div className="form-grid">
            <label>订单类型<select value={orderType} onChange={(e) => setOrderType(e.target.value as OrderType)}><option value="market">市价单</option><option value="limit">限价单</option></select></label>
            <label>数量<input className={amountInvalid ? "invalid" : ""} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></label>
            <label>数量单位<select value={amountUnit} onChange={(e) => setAmountUnit(e.target.value as AmountUnit)}><option value="base">币数量</option><option value="quote">USDT 金额</option></select></label>
            <label>杠杆倍数<input className={leverageInvalid ? "invalid" : ""} value={leverage} onChange={(e) => setLeverage(e.target.value)} inputMode="numeric" /></label>
            {orderType === "limit" && <label className="span-2">限价价格<input className={priceInvalid ? "invalid" : ""} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" /></label>}
          </div>
          <div className="trade-hint">
            <span>预计下单数量 {num(Number.isFinite(estimatedBaseAmount) ? estimatedBaseAmount : 0)} {baseSymbol(selectedSymbol)}</span>
            <span>预计最大可下单 {amountUnit === "quote" ? money(maxInputAmount) : `${num(maxInputAmount)} ${baseSymbol(selectedSymbol)}`}</span>
            <span>参考价 {validReferencePrice ? money(validReferencePrice) : "-"}</span>
          </div>
          {validationError && <div className="trade-error">{validationError}</div>}
          <div className="actions">
            <button className="buy" disabled={!canSubmit} onClick={() => submit("buy")}><Send size={16} />买入/做多</button>
            <button className="sell" disabled={!canSubmit} onClick={() => submit("sell")}><Send size={16} />卖出/做空</button>
          </div>
          </>}
        </div>

        <div className="panel portfolio">
          <div className="panel-header portfolio-header">
            <div className="tabs">
              <button className={portfolioTab === "positions" ? "active" : ""} onClick={() => setPortfolioTab("positions")}>当前仓位</button>
              <button className={portfolioTab === "orders" ? "active" : ""} onClick={() => setPortfolioTab("orders")}>当前委托</button>
            </div>
            <button className="icon-button compact" onClick={() => { setHistoryTab(portfolioTab); setModal("history"); }} title="历史明细"><History size={17} /></button>
          </div>
          {portfolioTab === "positions"
            ? openPositions.length === 0 ? <EmptyState text="暂无持仓中仓位" /> : <PositionCards positions={openPositions} readOnly={isBotAccount} onRisk={openRiskModal} onClose={(position) => openCloseModal(position, "partial")} onCloseAll={(position) => openCloseModal(position, "all")} />
            : currentOrders.length === 0 ? <EmptyState text="暂无当前委托" /> : <OpenOrderList items={currentOrders} readOnly={isBotAccount} onCancel={cancelCurrentOrder} />}
        </div>
      </section>

      {modal === "history" && <Modal title="历史明细" onClose={() => setModal(null)}><HistoryDetails accountId={account.accountId} tab={historyTab} setTab={setHistoryTab} /></Modal>}
      {modal === "stats" && <Modal title="账户统计" onClose={() => setModal(null)}><AccountStatsView accountId={account.accountId} /></Modal>}
      {modal === "account" && <Modal title="新增账户" onClose={() => setModal(null)}><AccountForm name={newAccountName} kind={newAccountKind} mode={newAccountMode} botType={newBotType} botConfig={newBotConfig} botDefinitions={botDefinitions} symbols={symbols} cash={newAccountCash} setName={setNewAccountName} setKind={setNewAccountKind} setMode={setNewAccountMode} setBotType={setNewBotType} setBotConfig={setNewBotConfig} setCash={setNewAccountCash} onSubmit={createAccount} /></Modal>}
      {modal === "close" && closePosition && <Modal title={closeMode === "all" ? "确认一键平仓" : "平仓"} onClose={() => setModal(null)}><ClosePositionForm position={closePosition} amount={closeAmount} percent={closePercent} mode={closeMode} setAmount={updateCloseAmount} setPercent={updateClosePercent} onSubmit={executeClosePosition} /></Modal>}
      {modal === "risk" && riskPosition && <Modal title="止盈止损" onClose={() => setModal(null)}><PositionRiskForm position={riskPosition} takeProfitPrice={takeProfitPrice} stopLossPrice={stopLossPrice} setTakeProfitPrice={setTakeProfitPrice} setStopLossPrice={setStopLossPrice} onSubmit={savePositionRisk} /></Modal>}
    </main>
  );
}

function Metric({ icon, label, value, tone, className = "" }: { icon: React.ReactNode; label: string; value: string; tone?: string; className?: string }) {
  return <div className={`metric ${className}`}><div className="metric-icon">{icon}</div><span>{label}</span><strong className={tone}>{value}</strong></div>;
}

function PanelHeader({ title, actionLabel, onAction }: { title: string; actionLabel?: string; onAction?: () => void }) {
  return <div className="panel-header"><h2>{title}</h2>{actionLabel && <button className="text-button" onClick={onAction}>{actionLabel}</button>}</div>;
}

function BotAccountPanel({ account, onStop }: { account: AccountSnapshot; onStop: () => void }) {
  const config = account.botConfig;
  return <>
    <PanelHeader title="机器人账户" />
    <div className="bot-status-card">
      <div><span>机器人类型</span><strong>{botTypeLabel(account.botType)}</strong></div>
      <div><span>运行状态</span><strong className={account.botStatus === "running" ? "up" : "down"}>{botStatusLabel(account.botStatus)}</strong></div>
      <div><span>阶段</span><strong>{account.botState?.phase === "holding" ? "持仓中" : account.botState?.phase === "ended" ? "已结束" : "等待开仓"}</strong></div>
      <div><span>交易次数</span><strong>{account.botState?.tradeCount ?? 0}</strong></div>
    </div>
    {config && <dl className="bot-config-list">
      <div><dt>交易对</dt><dd>{config.symbol}</dd></div>
      <div><dt>方向</dt><dd>{botDirectionLabel(config.direction)}</dd></div>
      <div><dt>数量</dt><dd>{config.amountUnit === "quote" ? money(config.amount) : num(config.amount)}</dd></div>
      <div><dt>杠杆</dt><dd>{config.leverage}x</dd></div>
      <div><dt>止盈</dt><dd>{rate(config.takeProfitPercent)}</dd></div>
      <div><dt>止损</dt><dd>{rate(config.stopLossPercent)}</dd></div>
      <div><dt>最大回撤</dt><dd>{rate(config.maxDrawdownPercent)}</dd></div>
      <div><dt>开仓间隔</dt><dd>{config.entryIntervalSeconds}s</dd></div>
    </dl>}
    {account.stopReason && <div className="confirm-box">停止原因：{account.stopReason}</div>}
    <button className="sell" disabled={account.botStatus !== "running"} onClick={onStop}>终止机器人</button>
  </>;
}

function PositionCards({ positions, readOnly = false, onRisk, onClose, onCloseAll }: { positions: Position[]; readOnly?: boolean; onRisk: (position: Position) => void; onClose: (position: Position) => void; onCloseAll: (position: Position) => void }) {
  return <div className="position-cards">{positions.map((p) => {
    const avgChange = positionAvgChange(p);
    const floatingRoi = p.margin > 0 ? p.unrealizedPnl / p.margin : 0;
    return <article className="position-card" key={p.id}>
      <div><strong>{p.symbol}</strong><span className={p.side === "long" ? "up" : "down"}>{positionSideLabel(p.side)} · {p.leverage}x</span></div>
      <div className="position-focus">
        <div><span>未实现盈亏</span><strong className={p.unrealizedPnl >= 0 ? "up" : "down"}>{money(p.unrealizedPnl)}</strong></div>
        <div><span>收益率</span><strong className={floatingRoi >= 0 ? "up" : "down"}>{rate(floatingRoi)}</strong></div>
        <div><span>已实现盈亏</span><strong className={p.realizedPnl >= 0 ? "up" : "down"}>{money(p.realizedPnl)}</strong></div>
      </div>
      <dl>
        <div><dt>剩余</dt><dd>{num(p.amount)}</dd></div>
        <div><dt>均价</dt><dd>{money(p.avgEntry)}</dd></div>
        <div><dt>标记价</dt><dd>{money(p.markPrice)}</dd></div>
        <div><dt>保证金占用</dt><dd>{money(p.margin)}</dd></div>
        <div><dt>仓位价值</dt><dd>{money(p.marketValue)}</dd></div>
        <div><dt>爆仓价</dt><dd>{p.liquidationPrice > 0 ? money(p.liquidationPrice) : "-"}</dd></div>
        <div><dt>止盈价</dt><dd>{p.takeProfitPrice ? money(p.takeProfitPrice) : "-"}</dd></div>
        <div><dt>止损价</dt><dd>{p.stopLossPrice ? money(p.stopLossPrice) : "-"}</dd></div>
        <div><dt>均价涨跌</dt><dd className={avgChange >= 0 ? "up" : "down"}>{rate(avgChange)}</dd></div>
      </dl>
      {!readOnly && <div className="position-actions">
        <button className="neutral ghost" onClick={() => onRisk(p)}>止盈止损</button>
        <button className="neutral ghost" onClick={() => onClose(p)}>平仓</button>
        <button className="sell" onClick={() => onCloseAll(p)}>一键平仓</button>
      </div>}
    </article>;
  })}</div>;
}

function OpenOrderList({ items, readOnly = false, onCancel }: { items: CurrentOrderItem[]; readOnly?: boolean; onCancel: (item: CurrentOrderItem) => void }) {
  return <div className="order-list">{items.map((item) => {
    if (item.kind === "limit") {
      const order = item.order;
      return <div className="order-item" key={item.id}>
        <div><strong>{order.symbol}</strong><span className="tag">限价委托</span></div>
        <div><span className={order.side === "buy" ? "up" : "down"}>{sideLabel(order.side)}</span><span>{order.leverage}x · {statusLabel(order.status)}</span></div>
        <div><span>委托价 {money(order.price)}</span><span>已成交 {num(order.filledAmount)}</span></div>
        <div><span>委托 {num(order.amount)}</span><span>剩余 {num(order.remainingAmount)}</span></div>
        {!readOnly && <button className="neutral ghost" onClick={() => onCancel(item)}>取消委托</button>}
      </div>;
    }
    const position = item.position;
    return <div className="order-item" key={item.id}>
      <div><strong>{position.symbol}</strong><span className="tag">止盈止损</span></div>
      <div><span className={item.kind === "takeProfit" ? "up" : "down"}>{item.kind === "takeProfit" ? "止盈" : "止损"}</span><span>{positionSideLabel(position.side)} · {position.leverage}x</span></div>
      <div><span>触发价 {money(item.triggerPrice)}</span><span>可平 {num(position.amount)}</span></div>
      {!readOnly && <button className="neutral ghost" onClick={() => onCancel(item)}>取消设置</button>}
    </div>;
  })}</div>;
}

function PositionRiskForm({
  position,
  takeProfitPrice,
  stopLossPrice,
  setTakeProfitPrice,
  setStopLossPrice,
  onSubmit
}: {
  position: Position;
  takeProfitPrice: string;
  stopLossPrice: string;
  setTakeProfitPrice: (value: string) => void;
  setStopLossPrice: (value: string) => void;
  onSubmit: () => void;
}) {
  const takeProfit = Number(takeProfitPrice);
  const stopLoss = Number(stopLossPrice);
  const takeProfitInvalid = takeProfitPrice !== "" && (!Number.isFinite(takeProfit) || takeProfit <= 0);
  const stopLossInvalid = stopLossPrice !== "" && (!Number.isFinite(stopLoss) || stopLoss <= 0);
  const sideHint = position.side === "long" ? "多头：止盈价通常高于均价，止损价通常低于均价" : "空头：止盈价通常低于均价，止损价通常高于均价";
  return <div className="modal-form">
    <div className="confirm-box">{position.symbol} · {positionSideLabel(position.side)} · 均价 {money(position.avgEntry)}。{sideHint}</div>
    <label>止盈价<input className={takeProfitInvalid ? "invalid" : ""} value={takeProfitPrice} onChange={(event) => setTakeProfitPrice(event.target.value)} inputMode="decimal" placeholder="留空表示不设置" /></label>
    <label>止损价<input className={stopLossInvalid ? "invalid" : ""} value={stopLossPrice} onChange={(event) => setStopLossPrice(event.target.value)} inputMode="decimal" placeholder="留空表示不设置" /></label>
    {(takeProfitInvalid || stopLossInvalid) && <div className="trade-error">价格必须大于 0，或留空取消设置</div>}
    <button className="neutral" disabled={takeProfitInvalid || stopLossInvalid} onClick={onSubmit}>保存止盈止损</button>
  </div>;
}

function ClosePositionForm({
  position,
  amount,
  percent,
  mode,
  setAmount,
  setPercent,
  onSubmit
}: {
  position: Position;
  amount: string;
  percent: number;
  mode: CloseMode;
  setAmount: (amount: string) => void;
  setPercent: (percent: number) => void;
  onSubmit: () => void;
}) {
  const numericAmount = Number(amount);
  const invalid = !Number.isFinite(numericAmount) || numericAmount <= 0 || numericAmount > position.amount;
  const closeSide = position.side === "long" ? "卖出平多" : "买入平空";
  return <div className="close-form">
    <div className="close-summary">
      <strong>{position.symbol}</strong>
      <span className={position.side === "long" ? "up" : "down"}>{positionSideLabel(position.side)} · {position.leverage}x</span>
      <span>可平数量 {num(position.amount)} {baseSymbol(position.symbol)}</span>
      <span>预计方向 {closeSide}</span>
    </div>
    {mode === "all" && <div className="confirm-box">将按市价平掉当前剩余仓位，请确认后执行。</div>}
    <label>平仓数量<input className={invalid ? "invalid" : ""} value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" /></label>
    <div className="percent-row">
      <input type="range" min="0" max="100" step="1" value={Math.round(percent)} onChange={(event) => setPercent(Number(event.target.value))} />
      <strong>{Math.round(percent)}%</strong>
    </div>
    <div className="quick-buttons">
      {[10, 25, 50, 100].map((value) => <button key={value} className="neutral ghost" onClick={() => setPercent(value)}>{value}%</button>)}
    </div>
    {invalid && <div className="trade-error">平仓数量必须大于 0，且不能超过当前可平数量</div>}
    <button className={mode === "all" ? "sell" : "neutral"} disabled={invalid} onClick={onSubmit}>{mode === "all" ? "确认一键平仓" : "确认平仓"}</button>
  </div>;
}

function HistoryDetails({ accountId, tab, setTab }: { accountId: string; tab: "positions" | "orders"; setTab: (tab: "positions" | "orders") => void }) {
  return <>
    <div className="modal-tabs tabs">
      <button className={tab === "positions" ? "active" : ""} onClick={() => setTab("positions")}>历史仓位</button>
      <button className={tab === "orders" ? "active" : ""} onClick={() => setTab("orders")}>全部订单</button>
    </div>
    {tab === "positions" ? <PositionHistory accountId={accountId} /> : <OrderHistory accountId={accountId} />}
  </>;
}

function AccountStatsView({ accountId }: { accountId: string }) {
  const [stats, setStats] = useState<AccountStats | null>(null);
  useEffect(() => {
    setStats(null);
    api.accountStats().then(setStats);
  }, [accountId]);
  if (!stats) return <EmptyState text="正在加载账户统计" />;
  if (stats.totalTrades === 0) return <EmptyState text="暂无平仓事件，完成平仓后会生成统计" />;
  return <div className="stats-view">
    <div className="stats-grid">
      <StatCard label="已结算盈亏" value={money(stats.totalPnl)} tone={stats.totalPnl >= 0 ? "up" : "down"} />
      <StatCard label="胜率" value={rate(stats.winRate)} />
      <StatCard label="最大回撤" value={rate(stats.maxDrawdown)} tone={stats.maxDrawdown > 0 ? "down" : undefined} />
      <StatCard label="手续费占比" value={rate(stats.feeRatio)} />
    </div>
    <div className="chart-panel">
      <div className="chart-title"><strong>资金曲线</strong><span>按平仓事件记录</span></div>
      <EquityChart events={stats.equityCurve} />
    </div>
    <div className="table-scroll stats-table">
      <table>
        <thead><tr><th>时间</th><th>交易对</th><th>方向</th><th>平仓数量</th><th>平仓均价</th><th>平仓盈亏</th><th>手续费</th><th>账户权益</th></tr></thead>
        <tbody>{stats.recentEvents.map((event) => <tr key={event.id}><td>{new Date(event.createdAt).toLocaleString()}</td><td>{event.symbol}</td><td className={event.side === "buy" ? "up" : "down"}>{sideLabel(event.side)}</td><td>{num(event.closeAmount)}</td><td>{money(event.closePrice)}</td><td className={event.closePnl >= 0 ? "up" : "down"}>{money(event.closePnl)}</td><td>{money(event.fee)}</td><td>{money(event.equity)}</td></tr>)}</tbody>
      </table>
    </div>
  </div>;
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className="stat-card"><span>{label}</span><strong className={tone}>{value}</strong></div>;
}

function EquityChart({ events }: { events: AccountEquityEvent[] }) {
  const width = 720;
  const height = 220;
  const padding = 18;
  const values = events.map((event) => event.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const points = events.map((event, index) => {
    const x = events.length === 1 ? width / 2 : padding + (index / (events.length - 1)) * (width - padding * 2);
    const y = height - padding - ((event.equity - min) / span) * (height - padding * 2);
    return `${x},${y}`;
  }).join(" ");
  return <svg className="equity-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="资金曲线">
    <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} />
    <line x1={padding} y1={padding} x2={padding} y2={height - padding} />
    <polyline points={points} />
    {events.map((event, index) => {
      const x = events.length === 1 ? width / 2 : padding + (index / (events.length - 1)) * (width - padding * 2);
      const y = height - padding - ((event.equity - min) / span) * (height - padding * 2);
      return <circle key={event.id} cx={x} cy={y} r="3"><title>{`${new Date(event.createdAt).toLocaleString()} ${money(event.equity)}`}</title></circle>;
    })}
    <text x={padding + 4} y={padding + 4}>{money(max)}</text>
    <text x={padding + 4} y={height - padding - 6}>{money(min)}</text>
  </svg>;
}

function PositionHistory({ accountId }: { accountId: string }) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Paginated<Position> | null>(null);
  useEffect(() => {
    setData(null);
    api.positionHistory(page, PAGE_SIZE).then(setData);
  }, [accountId, page]);
  if (!data) return <EmptyState text="正在加载仓位历史" />;
  if (data.total === 0) return <EmptyState text="暂无已平仓或部分平仓记录" />;
  return <><div className="table-scroll"><table><thead><tr><th>状态</th><th>交易对</th><th>方向</th><th>剩余</th><th>已平</th><th>杠杆</th><th>均价</th><th>平仓均价</th><th>均价涨跌</th><th>保证金</th><th>已实现盈亏</th><th>手续费</th><th>净收益率</th></tr></thead><tbody>{data.items.map((p) => { const avgChange = positionAvgChange(p); const settledRoi = p.openedMargin > 0 ? p.realizedPnl / p.openedMargin : 0; return <tr key={p.id}><td>{positionHistoryStatusLabel(p)}</td><td>{p.symbol}</td><td className={p.side === "long" ? "up" : "down"}>{positionSideLabel(p.side)}</td><td>{num(p.amount)}</td><td>{num(p.closedAmount)}</td><td>{p.leverage}x</td><td>{money(p.avgEntry)}</td><td>{p.closeAvgPrice > 0 ? money(p.closeAvgPrice) : "-"}</td><td className={avgChange >= 0 ? "up" : "down"}>{rate(avgChange)}</td><td>{money(p.margin)}</td><td className={p.realizedPnl >= 0 ? "up" : "down"}>{money(p.realizedPnl)}</td><td>{money(p.fees)}</td><td className={settledRoi >= 0 ? "up" : "down"}>{rate(settledRoi)}</td></tr>; })}</tbody></table></div><Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={setPage} /></>;
}

function OrderHistory({ accountId }: { accountId: string }) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Paginated<Order> | null>(null);
  useEffect(() => {
    setData(null);
    api.orders(page, PAGE_SIZE).then(setData);
  }, [accountId, page]);
  if (!data) return <EmptyState text="正在加载订单" />;
  if (data.total === 0) return <EmptyState text="暂无订单" />;
  return <><div className="table-scroll"><table><thead><tr><th>时间</th><th>交易对</th><th>方向</th><th>类型</th><th>委托数量</th><th>已成交</th><th>剩余</th><th>委托/成交价</th><th>杠杆</th><th>手续费</th><th>平仓盈亏</th><th>状态</th></tr></thead><tbody>{data.items.map((o) => <tr key={o.id}><td>{new Date(o.createdAt).toLocaleString()}</td><td>{o.symbol}</td><td className={o.side === "buy" ? "up" : "down"}>{sideLabel(o.side)}</td><td>{orderTypeLabel(o.type)}</td><td>{num(o.amount)}</td><td>{num(o.filledAmount)}</td><td>{num(o.remainingAmount)}</td><td>{money(o.price)} / {money(o.avgFillPrice)}</td><td>{o.leverage}x</td><td>{money(o.fee)}</td><td className={o.closePnl >= 0 ? "up" : "down"}>{money(o.closePnl)}</td><td title={o.reason}>{statusLabel(o.status)}</td></tr>)}</tbody></table></div><Pagination page={data.page} totalPages={data.totalPages} total={data.total} onPage={setPage} /></>;
}

function Pagination({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (page: number) => void }) {
  return <div className="pagination"><span>共 {total} 条 · 第 {page + 1}/{totalPages} 页</span><div><button className="neutral ghost" disabled={page === 0} onClick={() => onPage(page - 1)}>上一页</button><button className="neutral ghost" disabled={page >= totalPages - 1} onClick={() => onPage(page + 1)}>下一页</button></div></div>;
}

function AccountForm({
  name,
  kind,
  mode,
  botType,
  botConfig,
  botDefinitions,
  symbols,
  cash,
  setName,
  setKind,
  setMode,
  setBotType,
  setBotConfig,
  setCash,
  onSubmit
}: {
  name: string;
  kind: AccountKind;
  mode: AccountMode;
  botType: BotType;
  botConfig: RandomBotConfig;
  botDefinitions: BotDefinitionMeta[];
  symbols: string[];
  cash: string;
  setName: (value: string) => void;
  setKind: (value: AccountKind) => void;
  setMode: (value: AccountMode) => void;
  setBotType: (value: BotType) => void;
  setBotConfig: (value: RandomBotConfig) => void;
  setCash: (value: string) => void;
  onSubmit: () => void;
}) {
  const randomDefinition = botDefinitions.find((definition) => definition.type === botType);
  function updateBotConfig<K extends keyof RandomBotConfig>(key: K, value: RandomBotConfig[K]) {
    setBotConfig({ ...botConfig, [key]: value });
  }
  return <div className="modal-form">
    <label>账户名称<input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：随机交易机器人" /></label>
    <label>账户类型<select value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}><option value="paper">模拟账户</option><option value="live" disabled={mode === "bot"}>真实账户</option></select></label>
    <label>交易模式<select value={mode} onChange={(e) => { const nextMode = e.target.value as AccountMode; setMode(nextMode); if (nextMode === "bot") setKind("paper"); }}><option value="manual">手动账户</option><option value="bot">机器人账户</option></select></label>
    {kind === "paper" && <label>初始资金<input value={cash} onChange={(e) => setCash(e.target.value)} inputMode="decimal" /></label>}
    {mode === "bot" && <div className="bot-form">
      <label>机器人类型<select value={botType} onChange={(e) => { const nextType = e.target.value as BotType; setBotType(nextType); const definition = botDefinitions.find((item) => item.type === nextType); if (definition) setBotConfig({ ...definition.defaultConfig, symbol: symbols[0] ?? definition.defaultConfig.symbol }); }}><option value="random">随机交易机器人</option></select></label>
      <div className="confirm-box">{randomDefinition?.description ?? "机器人账户创建后将自动运行，不提供手动交易入口。"}</div>
      <div className="form-grid">
        <label>交易对<select value={botConfig.symbol} onChange={(e) => updateBotConfig("symbol", e.target.value)}>{symbols.map((symbol) => <option key={symbol}>{symbol}</option>)}</select></label>
        <label>方向<select value={botConfig.direction} onChange={(e) => updateBotConfig("direction", e.target.value as RandomBotConfig["direction"])}><option value="both">随机多空</option><option value="long">只做多</option><option value="short">只做空</option></select></label>
        <label>数量<input value={botConfig.amount} onChange={(e) => updateBotConfig("amount", Number(e.target.value))} inputMode="decimal" /></label>
        <label>数量单位<select value={botConfig.amountUnit} onChange={(e) => updateBotConfig("amountUnit", e.target.value as AmountUnit)}><option value="quote">USDT 金额</option><option value="base">币数量</option></select></label>
        <label>杠杆<input value={botConfig.leverage} onChange={(e) => updateBotConfig("leverage", Number(e.target.value))} inputMode="numeric" /></label>
        <label>再次开仓间隔<input value={botConfig.entryIntervalSeconds} onChange={(e) => updateBotConfig("entryIntervalSeconds", Number(e.target.value))} inputMode="numeric" /></label>
        <label>止盈比例<input value={botConfig.takeProfitPercent * 100} onChange={(e) => updateBotConfig("takeProfitPercent", Number(e.target.value) / 100)} inputMode="decimal" /></label>
        <label>止损比例<input value={botConfig.stopLossPercent * 100} onChange={(e) => updateBotConfig("stopLossPercent", Number(e.target.value) / 100)} inputMode="decimal" /></label>
        <label className="span-2">最大回撤<input value={botConfig.maxDrawdownPercent * 100} onChange={(e) => updateBotConfig("maxDrawdownPercent", Number(e.target.value) / 100)} inputMode="decimal" /></label>
      </div>
    </div>}
    <button className="neutral" onClick={onSubmit}>创建账户</button>
  </div>;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" role="dialog" aria-modal="true"><section className="modal"><div className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} title="关闭"><X size={18} /></button></div>{children}</section></div>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state">{text}</div>;
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value > 100 ? 2 : 6 }).format(value || 0);
}

function num(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value || 0);
}

function pct(value?: number) {
  if (value === undefined) return "-";
  return `${value.toFixed(2)}%`;
}

function rate(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function sideLabel(side: "buy" | "sell") {
  return side === "buy" ? "买入/做多" : "卖出/做空";
}

function positionSideLabel(side: "long" | "short") {
  return side === "long" ? "多头" : "空头";
}

function baseSymbol(symbol: string) {
  return symbol.split("/")[0] ?? "币";
}

function positionHistoryStatusLabel(position: Position) {
  if (position.status === "closed") return "已平仓";
  return "部分平仓";
}

function positionAvgChange(position: { avgEntry: number; markPrice: number; side: "long" | "short" }) {
  if (!position.avgEntry) return 0;
  const raw = (position.markPrice - position.avgEntry) / position.avgEntry;
  return position.side === "long" ? raw : -raw;
}

function orderTypeLabel(type: "market" | "limit") {
  return type === "market" ? "市价" : "限价";
}

function statusLabel(status: "open" | "partial" | "filled" | "rejected" | "canceled") {
  const labels = { open: "挂单中", partial: "部分成交", filled: "已成交", rejected: "已拒绝", canceled: "已取消" };
  return labels[status];
}

function accountKindLabel(kind: "paper" | "live") {
  return kind === "paper" ? "模拟账户" : "真实账户";
}

function accountModeLabel(mode: AccountMode, status?: BotStatus) {
  if (mode === "manual") return "手动";
  return `机器人${status ? ` · ${botStatusLabel(status)}` : ""}`;
}

function botTypeLabel(type?: BotType) {
  if (type === "random") return "随机交易机器人";
  return "机器人";
}

function botStatusLabel(status?: BotStatus) {
  if (status === "running") return "运行中";
  if (status === "ended") return "已结束";
  if (status === "stopped") return "已终止";
  return "未启动";
}

function botDirectionLabel(direction: RandomBotConfig["direction"]) {
  if (direction === "long") return "只做多";
  if (direction === "short") return "只做空";
  return "随机多空";
}

function validateOrderInput({
  amount,
  leverage,
  referencePrice,
  orderType,
  maxInputAmount
}: {
  amount: number;
  leverage: number;
  referencePrice: number;
  orderType: OrderType;
  maxInputAmount: number;
}) {
  if (!Number.isFinite(amount) || amount <= 0) return "数量必须大于 0";
  if (!Number.isFinite(leverage) || leverage <= 0) return "杠杆倍数必须大于 0";
  if (orderType === "limit" && referencePrice <= 0) return "限价价格必须大于 0";
  if (referencePrice <= 0) return "暂无可用参考价";
  if (maxInputAmount <= 0) return "当前可用余额不足";
  if (amount > maxInputAmount) return "数量超过预计最大可下单数量";
  return "";
}

function amountByPercent(amount: number, percent: number) {
  if (percent >= 100) return amount;
  return roundAmount(amount * clampPercent(percent) / 100);
}

function roundAmount(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const factor = 100_000_000;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
}

function formatAmountInput(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(8).replace(/\.?0+$/, "");
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 100);
}

function parseOptionalPositive(value: string) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
