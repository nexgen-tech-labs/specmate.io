// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { GET, POST } = await import('./route');

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/workspaces/x/connector-scope', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/workspaces/[workspaceId]/connector-scope', () => {
  let organization: { id: string };
  let otherOrganization: { id: string };
  let workspace: { id: string };
  let workspaceWithNoOrg: { id: string };
  let admin: { id: string };
  let viewer: { id: string };
  let connection: { id: string };
  let otherOrgConnection: { id: string };

  beforeAll(async () => {
    organization = await prisma.organization.create({ data: { name: 'Connector Scope Test Org' } });
    otherOrganization = await prisma.organization.create({
      data: { name: 'Connector Scope Test Org Other' },
    });
    workspace = await prisma.workspace.create({
      data: { name: 'Connector Scope Test WS', organizationId: organization.id },
    });
    workspaceWithNoOrg = await prisma.workspace.create({ data: { name: 'No Org WS' } });
    admin = await prisma.user.create({
      data: {
        email: `conn-scope-admin-${Date.now()}@test.local`,
        name: 'Admin',
        passwordHash: 'x',
      },
    });
    viewer = await prisma.user.create({
      data: {
        email: `conn-scope-viewer-${Date.now()}@test.local`,
        name: 'Viewer',
        passwordHash: 'x',
      },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: admin.id, role: 'ADMIN' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: viewer.id, role: 'VIEWER' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspaceWithNoOrg.id, userId: admin.id, role: 'ADMIN' },
    });
    connection = await prisma.connection.create({
      data: { organizationId: organization.id, toolKey: 'jira', authMethod: 'OAUTH' },
    });
    otherOrgConnection = await prisma.connection.create({
      data: { organizationId: otherOrganization.id, toolKey: 'jira', authMethod: 'OAUTH' },
    });
  });

  afterAll(async () => {
    await prisma.workspaceConnectionScope.deleteMany({
      where: { workspaceId: { in: [workspace.id, workspaceWithNoOrg.id] } },
    });
    await prisma.connection.deleteMany({
      where: { id: { in: [connection.id, otherOrgConnection.id] } },
    });
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: [workspace.id, workspaceWithNoOrg.id] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, viewer.id] } } });
    await prisma.workspace.deleteMany({
      where: { id: { in: [workspace.id, workspaceWithNoOrg.id] } },
    });
    await prisma.organization.deleteMany({
      where: { id: { in: [organization.id, otherOrganization.id] } },
    });
  });

  const params = (workspaceId: string) => Promise.resolve({ workspaceId });

  it('returns 401 when no one is signed in', async () => {
    currentSession = null;
    const res = await POST(
      makeRequest({ connectionId: connection.id, scopeValue: 'PAY', scopeLabel: 'Payments' }),
      {
        params: params(workspace.id),
      },
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-ADMIN member', async () => {
    currentSession = { user: { id: viewer.id } };
    const res = await POST(
      makeRequest({ connectionId: connection.id, scopeValue: 'PAY', scopeLabel: 'Payments' }),
      {
        params: params(workspace.id),
      },
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 when required fields are missing', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(makeRequest({ connectionId: connection.id }), {
      params: params(workspace.id),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the workspace has no organization', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(
      makeRequest({ connectionId: connection.id, scopeValue: 'PAY', scopeLabel: 'Payments' }),
      { params: params(workspaceWithNoOrg.id) },
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when the connection belongs to a different organization', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(
      makeRequest({
        connectionId: otherOrgConnection.id,
        scopeValue: 'PAY',
        scopeLabel: 'Payments',
      }),
      { params: params(workspace.id) },
    );
    expect(res.status).toBe(404);
  });

  it('creates a WorkspaceConnectionScope on success', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(
      makeRequest({ connectionId: connection.id, scopeValue: 'PAY', scopeLabel: 'Payments (PAY)' }),
      { params: params(workspace.id) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopeValue: string; scopeLabel: string };
    expect(body.scopeValue).toBe('PAY');
    expect(body.scopeLabel).toBe('Payments (PAY)');

    const row = await prisma.workspaceConnectionScope.findUnique({
      where: {
        workspaceId_connectionId: { workspaceId: workspace.id, connectionId: connection.id },
      },
    });
    expect(row).not.toBeNull();
  });

  it('upserts (updates) on a repeat call for the same workspace/connection pair', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(
      makeRequest({
        connectionId: connection.id,
        scopeValue: 'CORE',
        scopeLabel: 'Platform (CORE)',
      }),
      { params: params(workspace.id) },
    );
    expect(res.status).toBe(200);

    const rows = await prisma.workspaceConnectionScope.findMany({
      where: { workspaceId: workspace.id, connectionId: connection.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].scopeValue).toBe('CORE');
  });
});

describe('GET /api/workspaces/[workspaceId]/connector-scope', () => {
  let organization: { id: string };
  let workspace: { id: string };
  let viewer: { id: string };
  let outsider: { id: string };
  let connection: { id: string };

  beforeAll(async () => {
    organization = await prisma.organization.create({ data: { name: 'Connector Scope GET Org' } });
    workspace = await prisma.workspace.create({
      data: { name: 'Connector Scope GET WS', organizationId: organization.id },
    });
    viewer = await prisma.user.create({
      data: { email: `conn-scope-get-${Date.now()}@test.local`, name: 'Viewer', passwordHash: 'x' },
    });
    outsider = await prisma.user.create({
      data: {
        email: `conn-scope-get-outsider-${Date.now()}@test.local`,
        name: 'Outsider',
        passwordHash: 'x',
      },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: viewer.id, role: 'VIEWER' },
    });
    connection = await prisma.connection.create({
      data: { organizationId: organization.id, toolKey: 'jira', authMethod: 'OAUTH' },
    });
    await prisma.workspaceConnectionScope.create({
      data: {
        workspaceId: workspace.id,
        connectionId: connection.id,
        scopeValue: 'PAY',
        scopeLabel: 'Payments (PAY)',
      },
    });
  });

  afterAll(async () => {
    await prisma.workspaceConnectionScope.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.connection.deleteMany({ where: { id: connection.id } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } });
    await prisma.user.deleteMany({ where: { id: { in: [viewer.id, outsider.id] } } });
    await prisma.workspace.deleteMany({ where: { id: workspace.id } });
    await prisma.organization.deleteMany({ where: { id: organization.id } });
  });

  const params = (workspaceId: string) => Promise.resolve({ workspaceId });
  const getRequest = () => new Request('http://localhost/api/workspaces/x/connector-scope');

  it('returns 401 when no one is signed in', async () => {
    currentSession = null;
    const res = await GET(getRequest(), { params: params(workspace.id) });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-member', async () => {
    currentSession = { user: { id: outsider.id } };
    const res = await GET(getRequest(), { params: params(workspace.id) });
    expect(res.status).toBe(403);
  });

  it('returns the workspace scopes joined with tool key for any member (VIEWER included)', async () => {
    currentSession = { user: { id: viewer.id } };
    const res = await GET(getRequest(), { params: params(workspace.id) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scopes: Array<{
        connectionId: string;
        toolKey: string;
        scopeValue: string;
        scopeLabel: string;
      }>;
    };
    expect(body.scopes).toEqual([
      {
        connectionId: connection.id,
        toolKey: 'jira',
        scopeValue: 'PAY',
        scopeLabel: 'Payments (PAY)',
      },
    ]);
  });
});
