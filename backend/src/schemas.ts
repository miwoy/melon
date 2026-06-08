import { z } from "zod";

export const loginSchema = z.object({
  password: z.string().min(1)
});

export const createOrderSchema = z.object({
  symbol: z.string().min(3),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["market", "limit"]).default("market"),
  amount: z.number().positive(),
  amountUnit: z.enum(["base", "quote"]).default("base"),
  price: z.number().positive().optional(),
  leverage: z.number().int().min(1).max(125).default(1),
  accountId: z.string().optional()
}).refine((order) => order.type === "market" || order.price !== undefined, {
  message: "限价单必须填写价格",
  path: ["price"]
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(0).default(0),
  pageSize: z.coerce.number().int().min(1).max(100).default(10)
});

export const createAccountSchema = z.object({
  name: z.string().min(1).max(40),
  kind: z.enum(["paper", "live"]),
  startingCash: z.number().positive().optional()
});

export const switchAccountSchema = z.object({
  accountId: z.string().min(1)
});

export const positionRiskSchema = z.object({
  takeProfitPrice: z.number().positive().nullable().optional(),
  stopLossPrice: z.number().positive().nullable().optional()
});

export const idParamSchema = z.object({
  id: z.string().min(1)
});
