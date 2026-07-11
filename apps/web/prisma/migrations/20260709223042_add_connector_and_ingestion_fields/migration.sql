-- AlterTable
ALTER TABLE "Source" ADD COLUMN     "externalRef" TEXT,
ADD COLUMN     "parseError" TEXT;

-- CreateTable
CREATE TABLE "ReferenceItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tool" "PublishTarget" NOT NULL,
    "externalKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "url" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferenceItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceItem_projectId_tool_externalKey_key" ON "ReferenceItem"("projectId", "tool", "externalKey");

-- CreateIndex
CREATE UNIQUE INDEX "Source_projectId_externalRef_key" ON "Source"("projectId", "externalRef");

-- AddForeignKey
ALTER TABLE "ReferenceItem" ADD CONSTRAINT "ReferenceItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

