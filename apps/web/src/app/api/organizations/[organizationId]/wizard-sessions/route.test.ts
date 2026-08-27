// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const fetchMock = vi.fn(
  async () =>
    new Response(
      JSON.stringify({
        id: 'ows1',
        tool_key: 'jira',
        current_step: 'authenticate',
        collected_state: {},
      }),
      { status: 200 },
    ),
);
vi.stubGlobal('fetch', fetchMock);

const { POST } = await import('./route');

describe('POST /api/organizations/[organizationId]/wizard-sessions', () => {
  let organization: { id: string };
  let owner: { id: string };
  let outsider: { id: string };

  beforeAll(async () => {
    organization = await prisma.organization.create({
      data: { name: 'Org Wizard Session Test Org' },
    });
    owner = await prisma.user.create({
      data: { email: `org-wiz-owner-${Date.now()}@test.local`, name: 'Owner', passwordHash: 'x' },
    });
    outsider = await prisma.user.create({
      data: {
        email: `org-wiz-outsider-${Date.now()}@test.local`,
        name: 'Outsider',
        passwordHash: 'x',
      },
    });
    await prisma.organizationMember.create({
      data: { organizationId: organization.id, userId: owner.id, role: 'OWNER' },
    });
  });

  afterAll(async () => {
    await prisma.organizationMember.deleteMany({ where: { organizationId: organization.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, outsider.id] } } });
    await prisma.organization.deleteMany({ where: { id: organization.id } });
  });

  const params = () => Promise.resolve({ organizationId: organization.id });

  function makeRequest(): Request {
    return new Request('http://localhost/api/organizations/x/wizard-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_key: 'jira' }),
    });
  }

  it('returns 401 when no one is signed in', async () => {
    currentSession = null;
    const res = await POST(makeRequest(), { params: params() });
    expect(res.status).toBe(401);
  });

  it('returns 403 for someone not in the organization', async () => {
    currentSession = { user: { id: outsider.id } };
    const res = await POST(makeRequest(), { params: params() });
    expect(res.status).toBe(403);
  });

  it('proxies to apps/api for an OWNER', async () => {
    currentSession = { user: { id: owner.id } };
    const res = await POST(makeRequest(), { params: params() });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/organizations/${organization.id}/wizard-sessions`),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
