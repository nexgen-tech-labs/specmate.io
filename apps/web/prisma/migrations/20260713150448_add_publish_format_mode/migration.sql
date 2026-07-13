-- CreateEnum
CREATE TYPE "TicketFormatMode" AS ENUM ('HUMAN', 'CODING_AGENT', 'BOTH');

-- AlterTable
ALTER TABLE "PublishMapping" ADD COLUMN     "formatMode" "TicketFormatMode" NOT NULL DEFAULT 'HUMAN';

