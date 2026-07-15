// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { GET, POST } = await import('./route');
const { PATCH } = await import('./[teamId]/route');
const { POST: decidePost } =
  await import('../projects/[projectId]/draft-items/[itemId]/decision/route');

/**
 * Team management API + server-side team-scope enforcement (Issue 12.11 ACs:
 * scoped teams can't act outside their scope, checks enforced on API calls).
 */
describe('teams API and scope enforcement (Issue 12.11)', () => {
  let workspace: { id: string };
  let admin: { id: string };
  let reviewer: { id: string };
  let stranger: { id: string };
  let pInScope: { id: string };
  let pOutOfScope: { id: string };
  let itemInScope: { id: string };
  let itemOutOfScope: { id: string };
  let teamId: string;

  beforeAll(async () => {
    const stamp = Date.now();
    workspace = await prisma.workspace.create({ data: { name: 'Teams Test WS' } });
    [admin, reviewer, stranger] = await Promise.all(
      ['admin', 'reviewer', 'stranger'].map((tag) =>
        prisma.user.create({
          data: { email: `teams-${tag}-${stamp}@test.local`, name: tag, passwordHash: 'x' },
        }),
      ),
    );
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
        { workspaceId: workspace.id, userId: reviewer.id, role: 'REVIEWER' },
      ],
    });
    pInScope = await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'In Scope' },
    });
    pOutOfScope = await prisma.project.create({
      data: { workspaceId: workspace.id, name: 'Out Of Scope' },
    });
    itemInScope = await prisma.draftItem.create({
      data: { projectId: pInScope.id, type: 'STORY', title: 'In-scope item', description: 'd' },
    });
    itemOutOfScope = await prisma.draftItem.create({
      data: { projectId: pOutOfScope.id, type: 'STORY', title: 'Out item', description: 'd' },
    });
  });

  afterAll(async () => {
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL specmate.maintenance = 'on'`),
      prisma.auditEvent.deleteMany({ where: { workspaceId: workspace.id } }),
    ]);
    await prisma.teamProject.deleteMany({ where: { team: { workspaceId: workspace.id } } });
    await prisma.teamMember.deleteMany({ where: { team: { workspaceId: workspace.id } } });
    await prisma.team.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.reviewDecision.deleteMany({
      where: { draftItemId: { in: [itemInScope.id, itemOutOfScope.id] } },
    });
    await prisma.draftItem.deleteMany({
      where: { projectId: { in: [pInScope.id, pOutOfScope.id] } },
    });
    await prisma.project.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, reviewer.id, stranger.id] } } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
  });

  const params = { params: Promise.resolve({ workspaceId: '' }) };
  function wsParams() {
    return { params: Promise.resolve({ workspaceId: workspace.id }) };
  }

  it('an ADMIN can create a team; a REVIEWER cannot', async () => {
    currentSession = { user: { id: admin.id } };
    const created = await POST(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ name: 'BA Team' }),
      }),
      wsParams(),
    );
    expect(created.status).toBe(201);
    teamId = ((await created.json()) as { id: string }).id;

    currentSession = { user: { id: reviewer.id } };
    const denied = await POST(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify({ name: 'Rogue' }) }),
      wsParams(),
    );
    expect(denied.status).toBe(403);
  });

  it('team members must already be workspace members; scoped projects must be in-workspace', async () => {
    currentSession = { user: { id: admin.id } };
    const badMember = await PATCH(
      new Request('http://localhost', {
        method: 'PATCH',
        body: JSON.stringify({ addMemberIds: [stranger.id] }),
      }),
      { params: Promise.resolve({ workspaceId: workspace.id, teamId }) },
    );
    expect(badMember.status).toBe(400);

    const otherWs = await prisma.workspace.create({ data: { name: 'Teams Other WS' } });
    const foreignProject = await prisma.project.create({
      data: { workspaceId: otherWs.id, name: 'Foreign' },
    });
    const badProject = await PATCH(
      new Request('http://localhost', {
        method: 'PATCH',
        body: JSON.stringify({ projectIds: [foreignProject.id] }),
      }),
      { params: Promise.resolve({ workspaceId: workspace.id, teamId }) },
    );
    expect(badProject.status).toBe(400);
    await prisma.project.delete({ where: { id: foreignProject.id } });
    await prisma.workspace.delete({ where: { id: otherWs.id } });
  });

  it('scoping a reviewer to one project blocks their API access to other projects (404, no existence leak)', async () => {
    currentSession = { user: { id: admin.id } };
    const scoped = await PATCH(
      new Request('http://localhost', {
        method: 'PATCH',
        body: JSON.stringify({ addMemberIds: [reviewer.id], projectIds: [pInScope.id] }),
      }),
      { params: Promise.resolve({ workspaceId: workspace.id, teamId }) },
    );
    expect(scoped.status).toBe(200);

    currentSession = { user: { id: reviewer.id } };
    // Out-of-scope project: request is rejected as 404 before any action runs.
    const blocked = await decidePost(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }),
      {
        params: Promise.resolve({
          workspaceId: workspace.id,
          projectId: pOutOfScope.id,
          itemId: itemOutOfScope.id,
        }),
      },
    );
    expect(blocked.status).toBe(404);

    // In-scope project works normally.
    const allowed = await decidePost(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }),
      {
        params: Promise.resolve({
          workspaceId: workspace.id,
          projectId: pInScope.id,
          itemId: itemInScope.id,
        }),
      },
    );
    expect(allowed.status).toBe(200);

    // Cross-project containment: in-scope project URL + out-of-scope item id → 404.
    const smuggled = await decidePost(
      new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      }),
      {
        params: Promise.resolve({
          workspaceId: workspace.id,
          projectId: pInScope.id,
          itemId: itemOutOfScope.id,
        }),
      },
    );
    expect(smuggled.status).toBe(404);
  });

  it('admins keep full visibility regardless of team scope, and GET lists teams', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await GET(new Request('http://localhost'), wsParams());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      teams: Array<{ name: string; members: Array<{ userId: string }>; projectIds: string[] }>;
    };
    const team = body.teams.find((t) => t.name === 'BA Team');
    expect(team?.members.some((m) => m.userId === reviewer.id)).toBe(true);
    expect(team?.projectIds).toEqual([pInScope.id]);
  });

  it('unauthenticated requests are rejected', async () => {
    currentSession = null;
    const res = await GET(new Request('http://localhost'), wsParams());
    expect(res.status).toBe(401);
    void params;
  });
});
