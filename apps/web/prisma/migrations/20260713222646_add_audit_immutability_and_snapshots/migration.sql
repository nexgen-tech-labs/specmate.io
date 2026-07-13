-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM', 'AI');

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "actorType" "AuditActorType" NOT NULL DEFAULT 'USER',
ADD COLUMN     "afterState" JSONB,
ADD COLUMN     "beforeState" JSONB,
ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'TRACE_MAP',
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_projectId_createdAt_idx" ON "AuditEvent"("workspaceId", "projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "Snapshot" ADD CONSTRAINT "Snapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snapshot" ADD CONSTRAINT "Snapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DB-level immutability (Issue 8.1): AuditEvent is append-only — UPDATE and DELETE
-- are rejected by trigger for every role, including admins. The only escape hatch is
-- the `specmate.maintenance` session GUC, reserved for test-database cleanup and
-- future retention/compliance maintenance jobs; application code never sets it.
CREATE OR REPLACE FUNCTION specmate_block_audit_mutation() RETURNS trigger AS $$
BEGIN
  IF current_setting('specmate.maintenance', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AuditEvent rows are immutable (append-only audit log)';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_immutable
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION specmate_block_audit_mutation();

-- Snapshots are fixed artifacts (Issue 8.4): UPDATE is rejected (DELETE is allowed —
-- discarding a snapshot is legitimate; silently changing one is not).
CREATE OR REPLACE FUNCTION specmate_block_snapshot_update() RETURNS trigger AS $$
BEGIN
  IF current_setting('specmate.maintenance', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Snapshot rows are immutable once generated';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER snapshot_immutable
  BEFORE UPDATE ON "Snapshot"
  FOR EACH ROW EXECUTE FUNCTION specmate_block_snapshot_update();
