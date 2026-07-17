-- Issue 9.5: drift detection

ALTER TABLE "PublishedItem"
  ADD COLUMN "lastKnownState" JSONB,
  ADD COLUMN "lastSyncedAt" TIMESTAMP(3);

CREATE TYPE "DriftResolution" AS ENUM ('ACCEPT_EXTERNAL', 'REASSERT_SPECMATE');

CREATE TABLE "DriftFlag" (
    "id" TEXT NOT NULL,
    "publishedItemId" TEXT NOT NULL,
    "diff" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolution" "DriftResolution",
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,

    CONSTRAINT "DriftFlag_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DriftFlag"
  ADD CONSTRAINT "DriftFlag_publishedItemId_fkey"
  FOREIGN KEY ("publishedItemId") REFERENCES "PublishedItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
