-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'excel',
    "interval" TEXT NOT NULL,
    "hour" INTEGER NOT NULL DEFAULT 0,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "filters" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Schedule_shop_idx" ON "Schedule"("shop");

-- CreateIndex
CREATE INDEX "Schedule_enabled_nextRunAt_idx" ON "Schedule"("enabled", "nextRunAt");
