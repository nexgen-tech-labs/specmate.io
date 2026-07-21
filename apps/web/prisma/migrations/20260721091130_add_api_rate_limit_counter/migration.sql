-- API rate limiting (Issue #88): per-workspace, per-minute-window request counters.
CREATE TABLE "ApiRateLimitCounter" (
    "workspaceId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "requestCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ApiRateLimitCounter_pkey" PRIMARY KEY ("workspaceId", "windowStart")
);

ALTER TABLE "ApiRateLimitCounter" ADD CONSTRAINT "ApiRateLimitCounter_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
