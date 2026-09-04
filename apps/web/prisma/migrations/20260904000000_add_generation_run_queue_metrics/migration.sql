-- AlterTable
ALTER TABLE "GenerationRun" ADD COLUMN     "queueDepthAtSubmitMax" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "queueWaitSecondsTotal" DOUBLE PRECISION NOT NULL DEFAULT 0;
