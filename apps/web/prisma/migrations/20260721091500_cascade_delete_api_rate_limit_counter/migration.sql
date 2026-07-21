-- Rate-limit counters are meaningless once their workspace is deleted; cascade
-- so Workspace deletion (including in tests) doesn't require deleting counters
-- first (Issue #88 follow-up — this FK was originally RESTRICT, which broke
-- every pre-existing test that deletes its fixture Workspace in cleanup).
ALTER TABLE "ApiRateLimitCounter" DROP CONSTRAINT "ApiRateLimitCounter_workspaceId_fkey";

ALTER TABLE "ApiRateLimitCounter" ADD CONSTRAINT "ApiRateLimitCounter_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
