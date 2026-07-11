-- CreateEnum
CREATE TYPE "DraftItemStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EDITED');

-- AlterTable
ALTER TABLE "DraftItem" ADD COLUMN     "editHistory" JSONB,
ADD COLUMN     "flags" JSONB,
ADD COLUMN     "generationRunId" TEXT,
ADD COLUMN     "originalDraft" JSONB,
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "revisionOfId" TEXT,
ADD COLUMN     "scoreDetail" JSONB,
ADD COLUMN     "signedOffByUserId" TEXT,
ADD COLUMN     "status" "DraftItemStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "approvalStages" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "duplicateThreshold" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "GenerationRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "stats" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GenerationRun_projectId_contentHash_key" ON "GenerationRun"("projectId", "contentHash");

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

