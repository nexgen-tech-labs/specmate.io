-- DropForeignKey
ALTER TABLE "Source" DROP CONSTRAINT "Source_previousVersionId_fkey";

-- CreateTable
CREATE TABLE "UsageReconciliationFlag" (
    "id" TEXT NOT NULL,
    "usagePeriodId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "internalCount" INTEGER NOT NULL,
    "stripeCount" INTEGER NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,

    CONSTRAINT "UsageReconciliationFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageReconciliationFlag_usagePeriodId_key" ON "UsageReconciliationFlag"("usagePeriodId");

-- AddForeignKey
ALTER TABLE "UsageReconciliationFlag" ADD CONSTRAINT "UsageReconciliationFlag_usagePeriodId_fkey" FOREIGN KEY ("usagePeriodId") REFERENCES "UsagePeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageReconciliationFlag" ADD CONSTRAINT "UsageReconciliationFlag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_previousVersionId_fkey" FOREIGN KEY ("previousVersionId") REFERENCES "Source"("id") ON DELETE SET NULL ON UPDATE CASCADE;
