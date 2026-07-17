-- Onboarding Flow redesign: self-reported company size, collected at signup.

CREATE TYPE "OrgSize" AS ENUM ('SOLO', 'SMALL', 'MEDIUM', 'LARGE', 'ENTERPRISE');

ALTER TABLE "Organization" ADD COLUMN "size" "OrgSize";
