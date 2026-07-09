import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { POST } = await import('./route');

describe('POST /api/workspaces/[workspaceId]/invites — cross-workspace isolation', () => {
  let workspaceA: { id: string };
  let workspaceB: { id: string };
  let adminOfA: { id: string };
  let reviewerOfA: { id: string };
  let memberOfB: { id: string };

  beforeAll(async () => {
    workspaceA = await prisma.workspace.create({ data: { name: 'Isolation Test A' } });
    workspaceB = await prisma.workspace.create({ data: { name: 'Isolation Test B' } });

    adminOfA = await prisma.user.create({
      data: { email: `admin-a-${Date.now()}@test.local`, name: 'Admin A', passwordHash: 'x' },
    });
    reviewerOfA = await prisma.user.create({
      data: { email: `reviewer-a-${Date.now()}@test.local`, name: 'Reviewer A', passwordHash: 'x' },
    });
    memberOfB = await prisma.user.create({
      data: { email: `admin-b-${Date.now()}@test.local`, name: 'Admin B', passwordHash: 'x' },
    });

    await prisma.workspaceMember.create({
      data: { workspaceId: workspaceA.id, userId: adminOfA.id, role: 'ADMIN' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspaceA.id, userId: reviewerOfA.id, role: 'REVIEWER' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspaceB.id, userId: memberOfB.id, role: 'ADMIN' },
    });
  });

  afterAll(async () => {
    await prisma.workspaceInvite.deleteMany({
      where: { workspaceId: { in: [workspaceA.id, workspaceB.id] } },
    });
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: [workspaceA.id, workspaceB.id] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [adminOfA.id, reviewerOfA.id, memberOfB.id] } },
    });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceA.id, workspaceB.id] } } });
  });

  function makeRequest(body: object) {
    return new Request('http://localhost/api/workspaces/x/invites', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  it('returns 401 when no one is signed in', async () => {
    currentSession = null;
    const res = await POST(makeRequest({ email: 'x@y.com', role: 'VIEWER' }), {
      params: Promise.resolve({ workspaceId: workspaceA.id }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when workspace B's admin tries to invite into workspace A", async () => {
    currentSession = { user: { id: memberOfB.id } };
    const res = await POST(makeRequest({ email: 'x@y.com', role: 'VIEWER' }), {
      params: Promise.resolve({ workspaceId: workspaceA.id }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 403 when workspace A's REVIEWER (not ADMIN) tries to create an invite", async () => {
    currentSession = { user: { id: reviewerOfA.id } };
    const res = await POST(makeRequest({ email: 'x@y.com', role: 'VIEWER' }), {
      params: Promise.resolve({ workspaceId: workspaceA.id }),
    });
    expect(res.status).toBe(403);
  });

  it("succeeds when workspace A's ADMIN invites into their own workspace", async () => {
    currentSession = { user: { id: adminOfA.id } };
    const res = await POST(makeRequest({ email: 'newperson@acme.com', role: 'VIEWER' }), {
      params: Promise.resolve({ workspaceId: workspaceA.id }),
    });
    expect(res.status).toBe(201);
    const body: { token: string; inviteUrl: string } = await res.json();
    expect(body.token).toBeDefined();

    const invite = await prisma.workspaceInvite.findUnique({ where: { token: body.token } });
    expect(invite?.workspaceId).toBe(workspaceA.id);
    expect(invite?.email).toBe('newperson@acme.com');
  });
});
