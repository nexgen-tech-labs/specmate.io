-- Org-level connector authorization (Onboarding Flow redesign): "authorize
-- once, every workspace in the org picks its own board". Connection becomes
-- dual-scoped (workspaceId OR organizationId, exactly one set — enforced at
-- the application layer) rather than workspace-only; WorkspaceConnectionScope
-- records which board/project/repo a workspace picked from an org-level
-- Connection; OrgWizardSession is the org-scoped analogue of WizardSession.

-- DropForeignKey
ALTER TABLE "Connection" DROP CONSTRAINT "Connection_workspaceId_fkey";

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN     "organizationId" TEXT,
ALTER COLUMN "workspaceId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "onboardingChecklistDismissedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WorkspaceConnectionScope" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "scopeValue" TEXT NOT NULL,
    "scopeLabel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceConnectionScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgWizardSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "toolKey" TEXT NOT NULL,
    "currentStep" TEXT NOT NULL,
    "collectedState" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgWizardSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceConnectionScope_workspaceId_connectionId_key" ON "WorkspaceConnectionScope"("workspaceId", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_organizationId_toolKey_key" ON "Connection"("organizationId", "toolKey");

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceConnectionScope" ADD CONSTRAINT "WorkspaceConnectionScope_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceConnectionScope" ADD CONSTRAINT "WorkspaceConnectionScope_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgWizardSession" ADD CONSTRAINT "OrgWizardSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: promote every existing workspace-scoped Connection to org-level
-- sharing where its workspace has an organization (all real workspaces do,
-- per migration add_org_team_hierarchy's backfill). workspaceId is left
-- populated (not nulled) so existing workspace-scoped resolvers keep working
-- unchanged; this only adds the org-level lookup path alongside it.
-- Idempotent: only touches rows with organizationId still null.
UPDATE "Connection" c
SET "organizationId" = w."organizationId"
FROM "Workspace" w
WHERE c."workspaceId" = w."id"
  AND w."organizationId" IS NOT NULL
  AND c."organizationId" IS NULL;
