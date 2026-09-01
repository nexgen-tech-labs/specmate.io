-- Staged generation (Onboarding Flow redesign follow-up): epics are generated
-- and persisted first for human approval, then stories/tasks/supporting items
-- are generated only for approved epics via a second explicit call.
--
-- Existing GenerationRun rows default to stage='COMPLETE' (they represent the
-- old single-shot pipeline's finished runs), and updatedAt is backfilled from
-- createdAt before the NOT NULL constraint is applied — added as a nullable
-- column first, backfilled, then constrained, since a plain
-- "ADD COLUMN updatedAt TIMESTAMP NOT NULL" with no DEFAULT would fail against
-- any existing rows.

-- CreateEnum
CREATE TYPE "GenerationRunStage" AS ENUM ('EPICS_PENDING_REVIEW', 'COMPLETE');

-- AlterTable
ALTER TABLE "GenerationRun"
  ADD COLUMN     "stage" "GenerationRunStage" NOT NULL DEFAULT 'COMPLETE',
  ADD COLUMN     "summarizedFragmentsBlock" TEXT,
  ADD COLUMN     "updatedAt" TIMESTAMP(3);

-- Backfill: existing rows never had an updatedAt concept — createdAt is the
-- closest meaningful value (the run was created and completed in one shot).
UPDATE "GenerationRun" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;

ALTER TABLE "GenerationRun" ALTER COLUMN "updatedAt" SET NOT NULL;
