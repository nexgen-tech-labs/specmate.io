import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { GET, POST } = await import('./route');

describe('workspace GitHub App claim endpoint (Issue 10.3)', () => {
  let workspaceA: { id: string };
  let workspaceB: { id: string };
  let admin: { id: string };
  let unclaimedInstall: { id: string };
  let claimedByOther: { id: string };

  beforeAll(async () => {
    workspaceA = await prisma.workspace.create({ data: { name: 'GH App Test WS A' } });
    workspaceB = await prisma.workspace.create({ data: { name: 'GH App Test WS B' } });
    admin = await prisma.user.create({
      data: { email: `ghapp-admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspaceA.id, userId: admin.id, role: 'ADMIN' },
    });

    unclaimedInstall = await prisma.gitHubAppInstall.create({
      data: {
        installationId: BigInt(Date.now()),
        accountLogin: 'unclaimed-org',
        accountType: 'Organization',
        repositorySelection: 'all',
      },
    });
    claimedByOther = await prisma.gitHubAppInstall.create({
      data: {
        installationId: BigInt(Date.now() + 1),
        accountLogin: 'other-org',
        accountType: 'Organization',
        repositorySelection: 'all',
        workspaceId: workspaceB.id,
        claimedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await prisma.gitHubAppInstall.deleteMany({
      where: { id: { in: [unclaimedInstall.id, claimedByOther.id] } },
    });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspaceA.id } });
    await prisma.workspace.deleteMany({ where: { id: { in: [workspaceA.id, workspaceB.id] } } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
  });

  it('lists unclaimed installs for an admin', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ workspaceId: workspaceA.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unclaimed: Array<{ id: string }> };
    expect(body.unclaimed.some((i) => i.id === unclaimedInstall.id)).toBe(true);
  });

  it('claims an unclaimed install for the workspace', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ installId: unclaimedInstall.id }),
      }),
      { params: Promise.resolve({ workspaceId: workspaceA.id }) },
    );
    expect(res.status).toBe(200);

    const updated = await prisma.gitHubAppInstall.findUnique({
      where: { id: unclaimedInstall.id },
    });
    expect(updated?.workspaceId).toBe(workspaceA.id);
    expect(updated?.claimedAt).not.toBeNull();
  });

  it('refuses to claim an install already claimed by a different workspace', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ installId: claimedByOther.id }),
      }),
      { params: Promise.resolve({ workspaceId: workspaceA.id }) },
    );
    expect(res.status).toBe(409);
  });

  it('rejects an unauthenticated request', async () => {
    currentSession = null;
    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ workspaceId: workspaceA.id }),
    });
    expect(res.status).toBe(401);
  });
});
