import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', () => ({ auth: async () => currentSession }));

const { GET } = await import('./route');

describe('GET /api/organizations/[organizationId]/members', () => {
  let org: { id: string };
  let owner: { id: string };
  let admin: { id: string };
  let nonMember: { id: string };

  beforeAll(async () => {
    org = await prisma.organization.create({ data: { name: 'Org Members Test' } });
    owner = await prisma.user.create({
      data: { email: `org-owner-${Date.now()}@test.local`, name: 'Owner', passwordHash: 'x' },
    });
    admin = await prisma.user.create({
      data: { email: `org-admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    nonMember = await prisma.user.create({
      data: { email: `non-member-${Date.now()}@test.local`, name: 'NonMember', passwordHash: 'x' },
    });
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: owner.id, role: 'OWNER' },
    });
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    });
  });

  afterAll(async () => {
    await prisma.organizationMember.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, admin.id, nonMember.id] } } });
  });

  function makeRequest() {
    return new Request(`http://localhost/api/organizations/${org.id}/members`);
  }

  it('returns 401 when signed out', async () => {
    currentSession = null;
    const res = await GET(makeRequest(), { params: Promise.resolve({ organizationId: org.id }) });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-member', async () => {
    currentSession = { user: { id: nonMember.id } };
    const res = await GET(makeRequest(), { params: Promise.resolve({ organizationId: org.id }) });
    expect(res.status).toBe(403);
  });

  it('returns the member list for an org OWNER', async () => {
    currentSession = { user: { id: owner.id } };
    const res = await GET(makeRequest(), { params: Promise.resolve({ organizationId: org.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: owner.id, role: 'OWNER' }),
        expect.objectContaining({ userId: admin.id, role: 'ADMIN' }),
      ]),
    );
  });
});
