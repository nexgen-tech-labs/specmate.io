import type { OrgSize } from '@prisma/client';

// Shared between the onboarding signup form (collects this) and the workspace
// dashboard breadcrumb (displays it) so the label wording only lives in one place.
export const ORG_SIZE_OPTIONS: Array<{ value: OrgSize; label: string }> = [
  { value: 'SOLO', label: 'Just me' },
  { value: 'SMALL', label: '2–10 people' },
  { value: 'MEDIUM', label: '11–50 people' },
  { value: 'LARGE', label: '51–200 people' },
  { value: 'ENTERPRISE', label: '200+ people' },
];

const ORG_SIZE_LABELS: Record<OrgSize, string> = Object.fromEntries(
  ORG_SIZE_OPTIONS.map((o) => [o.value, o.label]),
) as Record<OrgSize, string>;

export function orgSizeLabel(size: OrgSize | null | undefined): string | null {
  if (!size) return null;
  return ORG_SIZE_LABELS[size] ?? null;
}
