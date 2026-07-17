-- Issue 9.1: Source versioning + diff tracking

ALTER TABLE "Source"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "previousVersionId" TEXT;

ALTER TABLE "Source"
  ADD CONSTRAINT "Source_previousVersionId_fkey"
  FOREIGN KEY ("previousVersionId") REFERENCES "Source"("id") ON DELETE SET NULL;

CREATE TABLE "SourceDiff" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "previousSourceId" TEXT NOT NULL,
    "addedCount" INTEGER NOT NULL,
    "removedCount" INTEGER NOT NULL,
    "modifiedCount" INTEGER NOT NULL,
    "unchangedCount" INTEGER NOT NULL,
    "fragments" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceDiff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SourceDiff_sourceId_key" ON "SourceDiff"("sourceId");

ALTER TABLE "SourceDiff"
  ADD CONSTRAINT "SourceDiff_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "Source"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
