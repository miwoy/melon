import type { AccountKind, AccountMode, AccountSnapshot, AccountStats, AmountUnit, BotDefinitionMeta, BotType, Order, OrderSide, OrderType, Paginated, Position, RandomBotConfig, Ticker, TradingAccount } from "../types";

const AUTH_STORAGE_KEY = "melon_auth_token";
let authToken = sessionStorage.getItem(AUTH_STORAGE_KEY) ?? "";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function accountQuery(accountId?: string) {
  return accountId ? `accountId=${encodeURIComponent(accountId)}` : "";
}

export function setAuthToken(token: string) {
  authToken = token;
  if (token) sessionStorage.setItem(AUTH_STORAGE_KEY, token);
  else sessionStorage.removeItem(AUTH_STORAGE_KEY);
}

export function getAuthToken() {
  return authToken;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (authToken) headers.set("authorization", `Bearer ${authToken}`);

  const response = await fetch(url, {
    ...init,
    headers
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  return response.json() as Promise<T>;
}

export const api = {
  authStatus: () => fetchJson<{ required: boolean }>("/api/auth/status"),
  login: (password: string) => fetchJson<{ token: string; expiresAt: number }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  symbols: () => fetchJson<{ symbols: string[] }>("/api/symbols"),
  botDefinitions: () => fetchJson<{ items: BotDefinitionMeta[] }>("/api/bots/definitions"),
  accounts: () => fetchJson<TradingAccount[]>("/api/accounts"),
  createAccount: (payload: { name: string; kind: AccountKind; mode?: AccountMode; botType?: BotType; botConfig?: RandomBotConfig; startingCash?: number }) =>
    fetchJson<TradingAccount>("/api/accounts", { method: "POST", body: JSON.stringify(payload) }),
  archiveAccount: (accountId: string) =>
    fetchJson<{ accounts: TradingAccount[]; account: AccountSnapshot }>(`/api/accounts/${accountId}/archive`, { method: "PATCH", body: JSON.stringify({ confirm: true }) }),
  deleteAccount: (accountId: string) =>
    fetchJson<{ accounts: TradingAccount[]; account: AccountSnapshot }>(`/api/accounts/${accountId}`, { method: "DELETE", body: JSON.stringify({ confirm: true }) }),
  stopBot: (accountId?: string) => fetchJson<AccountSnapshot>(`/api/bots/stop${accountId ? `?${accountQuery(accountId)}` : ""}`, { method: "POST" }),
  tickers: () => fetchJson<Record<string, Ticker>>("/api/tickers"),
  account: (accountId?: string) => accountId ? fetchJson<AccountSnapshot>(`/api/accounts/${accountId}/snapshot`) : fetchJson<AccountSnapshot>("/api/account"),
  accountStats: (accountId?: string) => fetchJson<AccountStats>(`/api/account/stats${accountId ? `?${accountQuery(accountId)}` : ""}`),
  orders: (accountId: string, page: number, pageSize: number) => fetchJson<Paginated<Order>>(`/api/orders/history?${accountQuery(accountId)}&page=${page}&pageSize=${pageSize}`),
  positionHistory: (accountId: string, page: number, pageSize: number) => fetchJson<Paginated<Position>>(`/api/positions/history?${accountQuery(accountId)}&page=${page}&pageSize=${pageSize}`),
  updatePositionRisk: (accountId: string, positionId: string, payload: { takeProfitPrice?: number | null; stopLossPrice?: number | null }) =>
    fetchJson<AccountSnapshot>(`/api/positions/${positionId}/risk?${accountQuery(accountId)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  cancelOrder: (accountId: string, orderId: string) => fetchJson<Order>(`/api/orders/${orderId}?${accountQuery(accountId)}`, { method: "DELETE" }),
  order: (payload: { accountId: string; clientOrderId: string; symbol: string; side: OrderSide; type: OrderType; amount: number; amountUnit: AmountUnit; price?: number; leverage: number }) =>
    fetchJson<Order>("/api/orders", {
      method: "POST",
      body: JSON.stringify(payload)
    })
};
