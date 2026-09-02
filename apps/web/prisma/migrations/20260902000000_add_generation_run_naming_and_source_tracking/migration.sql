-- AlterTable
ALTER TABLE "GenerationRun" ADD COLUMN     "name" TEXT,
ADD COLUMN     "tag" TEXT;

-- AlterTable
ALTER TABLE "Source" ADD COLUMN     "generatedInRunId" TEXT;

-- AddForeignKey
ALTER TABLE "Source" ADD CONSTRAINT "Source_generatedInRunId_fkey" FOREIGN KEY ("generatedInRunId") REFERENCES "GenerationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
