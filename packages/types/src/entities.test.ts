import { describe, expect, it } from 'vitest';
import type {
  AuditEvent,
  DraftItem,
  PublishedItem,
  Project,
  RawRequirement,
  ReviewDecision,
  Source,
  TraceLink,
  User,
  Workspace,
  WorkspaceMember,
} from './entities';

const now = new Date().toISOString();

describe('shared entity types', () => {
  it('allows constructing a valid Workspace', () => {
    const workspace: Workspace = {
      id: '1',
      name: 'Acme',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    expect(workspace.id).toBe('1');
  });

  it('allows constructing a valid User', () => {
    const user: User = {
      id: '1',
      email: 'jane@acme.com',
      name: 'Jane',
      createdAt: now,
      updatedAt: now,
    };
    expect(user.email).toBe('jane@acme.com');
  });

  it('allows constructing a valid WorkspaceMember', () => {
    const member: WorkspaceMember = {
      id: '1',
      workspaceId: '1',
      userId: '1',
      role: 'ADMIN',
      createdAt: now,
      updatedAt: now,
    };
    expect(member.role).toBe('ADMIN');
  });

  it('allows constructing a valid Project', () => {
    const project: Project = {
      id: '1',
      workspaceId: '1',
      name: 'Payments',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    expect(project.workspaceId).toBe('1');
  });

  it('allows constructing a valid Source', () => {
    const source: Source = {
      id: '1',
      projectId: '1',
      name: 'requirements.docx',
      kind: 'DOCX',
      status: 'PARSED',
      storageKey: 's3://bucket/key',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    expect(source.kind).toBe('DOCX');
  });

  it('allows constructing a valid RawRequirement', () => {
    const raw: RawRequirement = {
      id: '1',
      sourceId: '1',
      text: 'The system shall...',
      sectionPath: 'p.3',
      order: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    expect(raw.sourceId).toBe('1');
  });

  it('allows constructing a valid DraftItem', () => {
    const item: DraftItem = {
      id: '1',
      projectId: '1',
      type: 'STORY',
      title: 'As a user...',
      description: 'Details',
      payload: null,
      qualityScore: 91,
      parentId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    expect(item.type).toBe('STORY');
  });

  it('allows constructing a valid ReviewDecision', () => {
    const decision: ReviewDecision = {
      id: '1',
      draftItemId: '1',
      decision: 'APPROVED',
      actorUserId: '1',
      notes: null,
      createdAt: now,
    };
    expect(decision.decision).toBe('APPROVED');
  });

  it('allows constructing a valid PublishedItem', () => {
    const published: PublishedItem = {
      id: '1',
      draftItemId: '1',
      targetTool: 'JIRA',
      externalKey: 'PAY-141',
      externalUrl: 'https://example.atlassian.net/browse/PAY-141',
      createdAt: now,
      deletedAt: null,
    };
    expect(published.targetTool).toBe('JIRA');
  });

  it('allows constructing a valid AuditEvent', () => {
    const event: AuditEvent = {
      id: '1',
      workspaceId: '1',
      actorUserId: null,
      action: 'source.ingested',
      entityType: 'Source',
      entityId: '1',
      metadata: null,
      createdAt: now,
    };
    expect(event.action).toBe('source.ingested');
  });

  it('allows constructing a valid TraceLink', () => {
    const link: TraceLink = {
      id: '1',
      sourceId: '1',
      rawRequirementId: '1',
      draftItemId: '1',
      publishedItemId: null,
      createdAt: now,
      updatedAt: now,
    };
    expect(link.draftItemId).toBe('1');
  });
});
