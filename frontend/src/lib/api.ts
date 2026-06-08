import type { AccountKind, AccountSnapshot, AmountUnit, Order, OrderSide, OrderType, Paginated, Position, Ticker, TradingAccount } from "../types";

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

export function setAuthToken(token: string) {
  authToken = token;
  if (token) sessionStorage.setItem(AUTH_STORAGE_KEY, token);
  else sessionStorage.removeItem(AUTH_STORAGE_KEY);
}

export function getAuthToken() {
  return authToken;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...init?.headers
    }
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  return response.json() as Promise<T>;
}

export const api = {
  authStatus: () => fetchJson<{ required: boolean }>("/api/auth/status"),
  login: (password: string) => fetchJson<{ token: string; expiresAt: number }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  symbols: () => fetchJson<{ symbols: string[] }>("/api/symbols"),
  accounts: () => fetchJson<TradingAccount[]>("/api/accounts"),
  createAccount: (payload: { name: string; kind: AccountKind; startingCash?: number }) =>
    fetchJson<TradingAccount>("/api/accounts", { method: "POST", body: JSON.stringify(payload) }),
  switchAccount: (accountId: string) =>
    fetchJson<AccountSnapshot>("/api/accounts/active", { method: "PUT", body: JSON.stringify({ accountId }) }),
  tickers: () => fetchJson<Record<string, Ticker>>("/api/tickers"),
  account: () => fetchJson<AccountSnapshot>("/api/account"),
  orders: (page: number, pageSize: number) => fetchJson<Paginated<Order>>(`/api/orders/history?page=${page}&pageSize=${pageSize}`),
  positionHistory: (page: number, pageSize: number) => fetchJson<Paginated<Position>>(`/api/positions/history?page=${page}&pageSize=${pageSize}`),
  updatePositionRisk: (positionId: string, payload: { takeProfitPrice?: number | null; stopLossPrice?: number | null }) =>
    fetchJson<AccountSnapshot>(`/api/positions/${positionId}/risk`, { method: "PATCH", body: JSON.stringify(payload) }),
  cancelOrder: (orderId: string) => fetchJson<Order>(`/api/orders/${orderId}`, { method: "DELETE" }),
  order: (payload: { symbol: string; side: OrderSide; type: OrderType; amount: number; amountUnit: AmountUnit; price?: number; leverage: number }) =>
    fetchJson<Order>("/api/orders", {
      method: "POST",
      body: JSON.stringify(payload)
    })
};
