export interface Stage {
  id: number;
  key: string;
  label: string;
}

export const STAGES: Stage[] = [
  { id: 0, key: 'INGEST', label: 'Ingest sources' },
  { id: 1, key: 'GENERATE', label: 'AI generation' },
  { id: 2, key: 'REVIEW', label: 'Human review' },
  { id: 3, key: 'PUBLISH', label: 'Publish to tools' },
  { id: 4, key: 'AUDIT', label: 'Audit & sync' },
];

export interface Source {
  name: string;
  kind: string;
  items: string;
  icon: string;
}

export const SOURCES: Source[] = [
  { name: 'Client-Requirements-v3.docx', kind: 'Word', items: '14 pages', icon: '◫' },
  { name: 'Discovery-Workshop-Transcript.txt', kind: 'Transcript', items: '92 min', icon: '◉' },
  { name: 'Feature-Backlog-Export.xlsx', kind: 'Excel', items: '38 rows', icon: '▦' },
  { name: 'PAY project · existing backlog', kind: 'Jira Cloud', items: '126 issues', icon: '◈' },
];

export type ItemType = 'EPIC' | 'STORY' | 'RISK' | 'QUESTION' | 'NFR' | 'TEST';

export interface GenItem {
  id: string;
  type: ItemType;
  title: string;
  score: number | null;
  src: string;
  ac?: number;
  parent?: string;
  flag?: 'gap' | 'dup';
}

export const GEN_ITEMS: GenItem[] = [
  {
    id: 'E-1',
    type: 'EPIC',
    title: 'Customer self-service payment portal',
    score: 94,
    src: 'docx · p.3',
  },
  {
    id: 'S-1',
    type: 'STORY',
    title: 'As a customer, I can view outstanding invoices with due dates',
    score: 91,
    src: 'docx · p.4',
    ac: 4,
    parent: 'E-1',
  },
  {
    id: 'S-2',
    type: 'STORY',
    title: 'As a customer, I can pay an invoice via saved card or bank transfer',
    score: 88,
    src: 'transcript · 00:31',
    ac: 6,
    parent: 'E-1',
  },
  {
    id: 'S-3',
    type: 'STORY',
    title: 'As finance admin, I can reconcile portal payments against ERP',
    score: 72,
    src: 'xlsx · row 12',
    ac: 3,
    parent: 'E-1',
    flag: 'gap',
  },
  {
    id: 'R-1',
    type: 'RISK',
    title: 'PCI-DSS scope expands if card data touches portal backend',
    score: null,
    src: 'transcript · 01:12',
  },
  {
    id: 'Q-1',
    type: 'QUESTION',
    title: 'Which ERP version? Reconciliation API differs across NetSuite releases',
    score: null,
    src: 'xlsx · row 12',
  },
  {
    id: 'S-4',
    type: 'STORY',
    title: 'As a customer, I receive email receipt after successful payment',
    score: 90,
    src: 'docx · p.7',
    ac: 3,
    parent: 'E-1',
    flag: 'dup',
  },
  {
    id: 'N-1',
    type: 'NFR',
    title: 'Payment confirmation round-trip under 3s at p95',
    score: 85,
    src: 'docx · p.9',
  },
  {
    id: 'T-1',
    type: 'TEST',
    title: 'Scenario: card declined → invoice stays open, retry offered',
    score: 89,
    src: 'derived · S-2',
  },
];

export const TYPE_STYLE: Record<ItemType, { bg: string; fg: string }> = {
  EPIC: { bg: 'bg-cobalt-soft', fg: 'text-cobalt' },
  STORY: { bg: 'bg-[#F0F1F4]', fg: 'text-ink' },
  RISK: { bg: 'bg-red-soft', fg: 'text-red' },
  QUESTION: { bg: 'bg-amber-soft', fg: 'text-amber' },
  NFR: { bg: 'bg-[#EFEAF9]', fg: 'text-[#6D4BC4]' },
  TEST: { bg: 'bg-green-soft', fg: 'text-green' },
};

export interface Target {
  key: string;
  name: string;
  note: string;
  glyph: string;
  keyFmt: (n: number) => string;
}

export const TARGETS: Target[] = [
  {
    key: 'jira',
    name: 'Jira',
    note: 'Cloud + Data Center',
    glyph: '◆',
    keyFmt: (n) => `PAY-${140 + n}`,
  },
  {
    key: 'ado',
    name: 'Azure DevOps',
    note: 'Services + Server',
    glyph: '▲',
    keyFmt: (n) => `AB#${300 + n}`,
  },
  {
    key: 'github',
    name: 'GitHub Issues',
    note: 'github.com + GHES',
    glyph: '●',
    keyFmt: (n) => `#${86 + n}`,
  },
];

export interface AuditRow {
  t: string;
  who: string;
  what: string;
}

export const AUDIT_ROWS: AuditRow[] = [
  { t: '14:02:11', who: 'system', what: '4 sources ingested · 178 raw requirements extracted' },
  {
    t: '14:02:38',
    who: 'speclayer-ai',
    what: '9 items drafted · avg quality 87 · 1 duplicate, 1 gap flagged',
  },
  {
    t: '14:09:52',
    who: 'priya.n (BA)',
    what: 'Approved 7 · edited S-3 (added ERP version AC) · rejected S-4 as duplicate of PAY-118',
  },
  {
    t: '14:11:05',
    who: 'priya.n (BA)',
    what: 'Published 7 items → Jira · 7 → linked in Azure DevOps · 3 dev tasks → GitHub',
  },
  {
    t: '14:11:06',
    who: 'system',
    what: 'Trace map written: source → item → external key · immutable snapshot #a41f',
  },
];
