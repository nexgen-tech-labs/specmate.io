-- Issue 9.3: tag DraftItems produced by targeted regeneration with the triggering
-- Source version, so the delta review queue can filter to just that run's changes.

ALTER TABLE "DraftItem" ADD COLUMN "sourceVersionId" TEXT;
