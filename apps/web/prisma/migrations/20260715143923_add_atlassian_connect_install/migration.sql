-- CreateTable
CREATE TABLE "AtlassianConnectInstall" (
    "id" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "sharedSecret" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "displayUrl" TEXT,
    "productType" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "workspaceId" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AtlassianConnectInstall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AtlassianConnectInstall_clientKey_key" ON "AtlassianConnectInstall"("clientKey");

-- AddForeignKey
ALTER TABLE "AtlassianConnectInstall" ADD CONSTRAINT "AtlassianConnectInstall_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
