// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';

const { POST } = await import('./route');

function makeRequest(body: object) {
  return new Request('http://localhost/api/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Jane Doe',
    email: `signup-${Date.now()}-${Math.random()}@test.local`,
    password: 'password123',
    orgName: 'Acme Corp',
    orgSize: 'SMALL',
    workspaceName: 'Engineering',
    teamEmails: [],
    ...overrides,
  };
}

describe('POST /api/signup', () => {
  let createdUserIds: string[] = [];
  let createdWorkspaceIds: string[] = [];
  let createdOrgIds: string[] = [];

  afterEach(async () => {
    await prisma.workspaceInvite.deleteMany({
      where: { workspaceId: { in: createdWorkspaceIds } },
    });
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: createdWorkspaceIds } },
    });
    await prisma.organizationMember.deleteMany({
      where: { organizationId: { in: createdOrgIds } },
    });
    await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds = [];
    createdWorkspaceIds = [];
    createdOrgIds = [];
  });

  it('creates Organization with name + size, Workspace, and both membership rows', async () => {
    const body = validBody({ orgName: 'Acme Corp', orgSize: 'LARGE' });
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(201);
    const { workspaceId }: { workspaceId: string } = await res.json();
    createdWorkspaceIds.push(workspaceId);

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      include: { organization: true },
    });
    createdOrgIds.push(workspace.organizationId!);

    expect(workspace.organization?.name).toBe('Acme Corp');
    expect(workspace.organization?.size).toBe('LARGE');
    expect(workspace.name).toBe('Engineering');

    const user = await prisma.user.findUniqueOrThrow({ where: { email: body.email } });
    createdUserIds.push(user.id);

    const orgMember = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId: workspace.organizationId!, userId: user.id },
      },
    });
    expect(orgMember?.role).toBe('OWNER');

    const wsMember = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
    });
    expect(wsMember?.role).toBe('ADMIN');
  });

  it('rejects an invalid orgSize value', async () => {
    const res = await POST(makeRequest(validBody({ orgSize: 'GIGANTIC' })));
    expect(res.status).toBe(400);
  });

  it('rejects a missing orgName', async () => {
    const res = await POST(makeRequest(validBody({ orgName: '' })));
    expect(res.status).toBe(400);
  });

  it('creates a WorkspaceInvite per team email, 7-day TTL, REVIEWER role', async () => {
    const body = validBody({ teamEmails: ['bob@acme.com', 'carol@acme.com'] });
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(201);
    const { workspaceId }: { workspaceId: string } = await res.json();
    createdWorkspaceIds.push(workspaceId);

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    createdOrgIds.push(workspace.organizationId!);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: body.email } });
    createdUserIds.push(user.id);

    const invites = await prisma.workspaceInvite.findMany({
      where: { workspaceId },
      orderBy: { email: 'asc' },
    });
    expect(invites).toHaveLength(2);
    expect(invites.map((i) => i.email)).toEqual(['bob@acme.com', 'carol@acme.com']);
    for (const invite of invites) {
      expect(invite.role).toBe('REVIEWER');
      expect(invite.invitedByUserId).toBe(user.id);
      expect(invite.status).toBe('PENDING');
      const ttlDays =
        (invite.expiresAt.getTime() - invite.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      expect(ttlDays).toBeCloseTo(7, 0);
    }
  });

  it('creates no WorkspaceInvite rows when teamEmails is empty (solo signup unaffected)', async () => {
    const body = validBody({ teamEmails: [] });
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(201);
    const { workspaceId }: { workspaceId: string } = await res.json();
    createdWorkspaceIds.push(workspaceId);
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    createdOrgIds.push(workspace.organizationId!);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: body.email } });
    createdUserIds.push(user.id);

    const invites = await prisma.workspaceInvite.findMany({ where: { workspaceId } });
    expect(invites).toHaveLength(0);
  });

  it('rejects signup for an email that already has an account', async () => {
    const body = validBody();
    const first = await POST(makeRequest(body));
    expect(first.status).toBe(201);
    const { workspaceId }: { workspaceId: string } = await first.json();
    createdWorkspaceIds.push(workspaceId);
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    createdOrgIds.push(workspace.organizationId!);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: body.email } });
    createdUserIds.push(user.id);

    const second = await POST(makeRequest(body));
    expect(second.status).toBe(409);
  });
});
