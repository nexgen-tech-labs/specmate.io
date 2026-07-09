-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED');

-- AlterTable
ALTER TABLE "Source" ADD COLUMN     "mimeType" TEXT,
ADD COLUMN     "scanStatus" "ScanStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "sizeBytes" INTEGER;
