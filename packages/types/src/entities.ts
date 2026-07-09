export type Role = 'ADMIN' | 'REVIEWER' | 'VIEWER';

export type SourceKind =
  | 'DOCX'
  | 'PDF'
  | 'XLSX'
  | 'CSV'
  | 'TXT'
  | 'TRANSCRIPT'
  | 'CONFLUENCE'
  | 'SLACK'
  | 'JIRA_REF'
  | 'ADO_REF'
  | 'GITHUB_REF';

export type SourceStatus = 'QUEUED' | 'PARSING' | 'PARSED' | 'FAILED';

export type DraftItemType =
  | 'EPIC'
  | 'STORY'
  | 'TASK'
  | 'SUBTASK'
  | 'ACCEPTANCE_CRITERIA'
  | 'TEST'
  | 'RISK'
  | 'NFR'
  | 'DEPENDENCY'
  | 'ASSUMPTION'
  | 'QUESTION';

export type ReviewDecisionType = 'APPROVED' | 'REJECTED' | 'EDITED';

export type PublishTarget = 'JIRA' | 'ADO' | 'GITHUB';

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Source {
  id: string;
  projectId: string;
  name: string;
  kind: SourceKind;
  status: SourceStatus;
  storageKey: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface RawRequirement {
  id: string;
  sourceId: string;
  text: string;
  sectionPath: string;
  order: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface DraftItem {
  id: string;
  projectId: string;
  type: DraftItemType;
  title: string;
  description: string;
  payload: Record<string, unknown> | null;
  qualityScore: number | null;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ReviewDecision {
  id: string;
  draftItemId: string;
  decision: ReviewDecisionType;
  actorUserId: string;
  notes: string | null;
  createdAt: string;
}

export interface PublishedItem {
  id: string;
  draftItemId: string;
  targetTool: PublishTarget;
  externalKey: string;
  externalUrl: string;
  createdAt: string;
  deletedAt: string | null;
}

export interface AuditEvent {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface TraceLink {
  id: string;
  sourceId: string;
  rawRequirementId: string;
  draftItemId: string;
  publishedItemId: string | null;
  createdAt: string;
  updatedAt: string;
}
