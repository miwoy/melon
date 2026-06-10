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
  accountId: z.string().optional(),
  clientOrderId: z.string().min(8).max(120).optional()
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
  mode: z.enum(["manual", "bot"]).default("manual"),
  botType: z.enum(["random"]).optional(),
  botConfig: z.object({
    symbol: z.string().min(3),
    direction: z.enum(["long", "short", "both"]),
    amount: z.number().positive(),
    amountUnit: z.enum(["base", "quote"]),
    leverage: z.number().int().min(1).max(125),
    takeProfitPercent: z.number().positive(),
    stopLossPercent: z.number().positive(),
    maxDrawdownPercent: z.number().positive(),
    entryIntervalSeconds: z.number().int().min(0)
  }).optional(),
  startingCash: z.number().positive().optional()
}).superRefine((account, ctx) => {
  if (account.mode === "manual") return;
  if (account.kind !== "paper") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "第一版仅支持模拟机器人账户", path: ["kind"] });
  }
  if (!account.botType) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "机器人账户必须选择机器人类型", path: ["botType"] });
  }
  if (!account.botConfig) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "机器人账户必须填写机器人参数", path: ["botConfig"] });
  }
});

export const switchAccountSchema = z.object({
  accountId: z.string().min(1)
});

export const accountQuerySchema = z.object({
  accountId: z.string().min(1).optional()
});

export const positionRiskSchema = z.object({
  takeProfitPrice: z.number().positive().nullable().optional(),
  stopLossPrice: z.number().positive().nullable().optional()
});

export const idParamSchema = z.object({
  id: z.string().min(1)
});
