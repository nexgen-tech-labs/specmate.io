/**
 * Draft-item taxonomy shapes (Issue 3.2) — hand-mirrors the canonical JSON schemas
 * in apps/api/app/services/generation/schemas.py (the enforcement side), following
 * the same cross-language mirror convention as Prisma <-> SQLAlchemy.
 */

// DraftItemType itself lives in entities.ts (the core entity mirror).
export type DraftItemStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EDITED';

/** Type-specific payload fields; irrelevant fields are omitted per item type. */
export interface DraftItemPayload {
  business_value?: string; // EPIC
  statement?: string; // ACCEPTANCE_CRITERIA
  steps?: string[]; // TEST
  expected_result?: string; // TEST
  dependency_type?: 'blocks' | 'blocked-by' | 'external'; // DEPENDENCY
  confidence?: 'low' | 'medium' | 'high'; // ASSUMPTION
  needed_to_resolve?: string; // QUESTION
  severity?: 'low' | 'medium' | 'high'; // RISK
  category?: string; // NFR
  threshold?: string; // NFR
}

export interface DraftItemScoreDetail {
  completeness: number;
  clarity: number;
  testability: number;
  specificity: number;
  rationale: string;
}

export interface DraftItemFlags {
  duplicate?: { key: string; tool: 'JIRA' | 'ADO' | 'GITHUB'; confidence: number };
  gap?: { question: string };
  noTrace?: boolean;
}
