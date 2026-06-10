import "dotenv/config";
import { prisma } from "./db.js";

const paperTakerFeeRate = Number(process.env.PAPER_TAKER_FEE_RATE ?? 0.0005);

await prisma.$executeRawUnsafe(`
CREATE TABLE IF NOT EXISTS "Account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "cash" REAL NOT NULL,
  "realizedPnl" REAL NOT NULL DEFAULT 0,
  "totalFees" REAL NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "mode" TEXT NOT NULL DEFAULT 'manual',
  "botType" TEXT,
  "botStatus" TEXT,
  "botConfig" JSONB,
  "botState" JSONB,
  "startedAt" DATETIME,
  "stoppedAt" DATETIME,
  "stopReason" TEXT,
  "archivedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

await addColumnIfMissing("Account", "mode", "TEXT NOT NULL DEFAULT 'manual'");
await addColumnIfMissing("Account", "botType", "TEXT");
await addColumnIfMissing("Account", "botStatus", "TEXT");
await addColumnIfMissing("Account", "botConfig", "JSONB");
await addColumnIfMissing("Account", "botState", "JSONB");
await addColumnIfMissing("Account", "startedAt", "DATETIME");
await addColumnIfMissing("Account", "stoppedAt", "DATETIME");
await addColumnIfMissing("Account", "stopReason", "TEXT");
await addColumnIfMissing("Account", "archivedAt", "DATETIME");
await prisma.$executeRawUnsafe(`UPDATE "Account" SET "mode" = COALESCE("mode", 'manual');`);

await prisma.$executeRawUnsafe(`
CREATE TABLE IF NOT EXISTS "Position" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "base" TEXT NOT NULL,
  "quote" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "signedAmount" REAL NOT NULL,
  "amount" REAL NOT NULL,
  "openedAmount" REAL NOT NULL DEFAULT 0,
  "closedAmount" REAL NOT NULL DEFAULT 0,
  "avgEntry" REAL NOT NULL,
  "closeAvgPrice" REAL NOT NULL DEFAULT 0,
  "markPrice" REAL NOT NULL,
  "marketValue" REAL NOT NULL,
  "takeProfitPrice" REAL,
  "stopLossPrice" REAL,
  "leverage" INTEGER NOT NULL,
  "margin" REAL NOT NULL,
  "openedMargin" REAL NOT NULL DEFAULT 0,
  "realizedPnl" REAL NOT NULL DEFAULT 0,
  "unrealizedPnl" REAL NOT NULL,
  "fees" REAL NOT NULL DEFAULT 0,
  "netPnl" REAL NOT NULL DEFAULT 0,
  "roi" REAL NOT NULL DEFAULT 0,
  "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" DATETIME,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Position_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`);

await addColumnIfMissing("Position", "status", "TEXT NOT NULL DEFAULT 'open'");
await addColumnIfMissing("Position", "openedAmount", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Position", "closedAmount", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Position", "closeAvgPrice", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Position", "takeProfitPrice", "REAL");
await addColumnIfMissing("Position", "stopLossPrice", "REAL");
await addColumnIfMissing("Position", "openedMargin", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Position", "realizedPnl", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Position", "fees", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Position", "netPnl", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Position", "roi", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Position", "openedAt", "DATETIME");
await addColumnIfMissing("Position", "closedAt", "DATETIME");
await prisma.$executeRawUnsafe(`UPDATE "Position" SET "openedAt" = COALESCE("openedAt", "updatedAt", CURRENT_TIMESTAMP);`);
await prisma.$executeRawUnsafe(`UPDATE "Position" SET "openedAmount" = "amount" WHERE "openedAmount" = 0;`);
await prisma.$executeRawUnsafe(`UPDATE "Position" SET "openedMargin" = "margin" WHERE "openedMargin" = 0;`);
await prisma.$executeRawUnsafe(`UPDATE "Position" SET "closeAvgPrice" = "markPrice" WHERE "closedAmount" > 0 AND "closeAvgPrice" = 0;`);
await prisma.$executeRawUnsafe(`
UPDATE "Position"
SET "fees" = COALESCE((
  SELECT SUM("fee") FROM "Order"
  WHERE "Order"."accountId" = "Position"."accountId"
    AND "Order"."symbol" = "Position"."symbol"
    AND "Order"."status" = 'filled'
), 0)
WHERE "fees" = 0;
`);
await prisma.$executeRawUnsafe(`UPDATE "Position" SET "netPnl" = "realizedPnl" + "unrealizedPnl";`);
await prisma.$executeRawUnsafe(`UPDATE "Position" SET "roi" = CASE WHEN "openedMargin" > 0 THEN "netPnl" / "openedMargin" ELSE 0 END;`);

await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "Position_accountId_symbol_key";`);
await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Position_accountId_status_idx" ON "Position"("accountId", "status");`);
await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Position_accountId_symbol_idx" ON "Position"("accountId", "symbol");`);

await prisma.$executeRawUnsafe(`
CREATE TABLE IF NOT EXISTS "Order" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientOrderId" TEXT,
  "accountId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "amount" REAL NOT NULL,
  "filledAmount" REAL NOT NULL DEFAULT 0,
  "remainingAmount" REAL NOT NULL DEFAULT 0,
  "avgFillPrice" REAL NOT NULL DEFAULT 0,
  "price" REAL NOT NULL,
  "leverage" INTEGER NOT NULL,
  "fee" REAL NOT NULL,
  "closeAmount" REAL NOT NULL DEFAULT 0,
  "closeFee" REAL NOT NULL DEFAULT 0,
  "closePnl" REAL NOT NULL DEFAULT 0,
  "margin" REAL NOT NULL,
  "status" TEXT NOT NULL,
  "positionId" TEXT,
  "reason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME,
  "filledAt" DATETIME,
  CONSTRAINT "Order_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`);

await addColumnIfMissing("Order", "clientOrderId", "TEXT");
await addColumnIfMissing("Order", "filledAmount", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Order", "remainingAmount", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Order", "avgFillPrice", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Order", "closeAmount", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Order", "closeFee", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Order", "closePnl", "REAL NOT NULL DEFAULT 0");
await addColumnIfMissing("Order", "positionId", "TEXT");
await addColumnIfMissing("Order", "updatedAt", "DATETIME");
await addColumnIfMissing("Order", "filledAt", "DATETIME");
await prisma.$executeRawUnsafe(`UPDATE "Order" SET "filledAmount" = "amount" WHERE "status" = 'filled' AND "filledAmount" = 0;`);
await prisma.$executeRawUnsafe(`UPDATE "Order" SET "remainingAmount" = CASE WHEN "status" IN ('open', 'partial') THEN MAX("amount" - "filledAmount", 0) ELSE 0 END WHERE "remainingAmount" = 0;`);
await prisma.$executeRawUnsafe(`UPDATE "Order" SET "avgFillPrice" = "price" WHERE "status" = 'filled' AND "avgFillPrice" = 0;`);
await prisma.$executeRawUnsafe(`UPDATE "Order" SET "updatedAt" = COALESCE("updatedAt", "createdAt");`);
await prisma.$executeRawUnsafe(`UPDATE "Order" SET "filledAt" = COALESCE("filledAt", "updatedAt", "createdAt") WHERE "status" = 'filled';`);
await prisma.$executeRawUnsafe(`
UPDATE "Order"
SET "fee" = "filledAmount" * CASE WHEN "avgFillPrice" > 0 THEN "avgFillPrice" ELSE "price" END * ${paperTakerFeeRate}
WHERE "type" = 'market'
  AND "status" IN ('filled', 'partial')
  AND "filledAmount" > 0;
`);
await prisma.$executeRawUnsafe(`
UPDATE "Account"
SET "totalFees" = COALESCE((
  SELECT SUM("fee")
  FROM "Order"
  WHERE "Order"."accountId" = "Account"."id"
    AND "Order"."status" IN ('filled', 'partial')
), 0);
`);
await prisma.$executeRawUnsafe(`
UPDATE "Account"
SET "realizedPnl" = COALESCE((
  SELECT SUM("realizedPnl")
  FROM "Position"
  WHERE "Position"."accountId" = "Account"."id"
), 0);
`);

await prisma.$executeRawUnsafe(`
CREATE INDEX IF NOT EXISTS "Order_accountId_createdAt_idx" ON "Order"("accountId", "createdAt");
`);
await prisma.$executeRawUnsafe(`
CREATE INDEX IF NOT EXISTS "Order_positionId_idx" ON "Order"("positionId");
`);
await prisma.$executeRawUnsafe(`
CREATE UNIQUE INDEX IF NOT EXISTS "Order_accountId_clientOrderId_key" ON "Order"("accountId", "clientOrderId") WHERE "clientOrderId" IS NOT NULL;
`);

await prisma.$executeRawUnsafe(`
CREATE TABLE IF NOT EXISTS "AccountEquityEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "eventKey" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "positionId" TEXT,
  "symbol" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "closeAmount" REAL NOT NULL,
  "closePrice" REAL NOT NULL,
  "closePnl" REAL NOT NULL,
  "fee" REAL NOT NULL,
  "realizedPnl" REAL NOT NULL,
  "equity" REAL NOT NULL,
  "cash" REAL NOT NULL,
  "totalFees" REAL NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountEquityEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`);
await addColumnIfMissing("AccountEquityEvent", "eventKey", "TEXT");
await prisma.$executeRawUnsafe(`UPDATE "AccountEquityEvent" SET "eventKey" = COALESCE("eventKey", "orderId");`);
await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "AccountEquityEvent_orderId_key";`);
await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "AccountEquityEvent_eventKey_key" ON "AccountEquityEvent"("eventKey");`);
await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AccountEquityEvent_accountId_createdAt_idx" ON "AccountEquityEvent"("accountId", "createdAt");`);
await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AccountEquityEvent_orderId_idx" ON "AccountEquityEvent"("orderId");`);

await prisma.$disconnect();

async function addColumnIfMissing(table: string, column: string, definition: string) {
  const columns = (await prisma.$queryRawUnsafe(`PRAGMA table_info("${table}")`)) as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition};`);
}
