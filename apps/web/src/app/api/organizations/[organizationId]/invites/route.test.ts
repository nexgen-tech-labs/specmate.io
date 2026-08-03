import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', () => ({ auth: async () => currentSession }));

const { POST } = await import('./route');

describe('POST /api/organizations/[organizationId]/invites', () => {
  let org: { id: string };
  let owner: { id: string };
  let admin: { id: string };
  let nonMember: { id: string };

  beforeAll(async () => {
    org = await prisma.organization.create({ data: { name: 'Org Invites Test' } });
    owner = await prisma.user.create({
      data: { email: `inv-owner-${Date.now()}@test.local`, name: 'Owner', passwordHash: 'x' },
    });
    admin = await prisma.user.create({
      data: { email: `inv-admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    nonMember = await prisma.user.create({
      data: {
        email: `inv-non-member-${Date.now()}@test.local`,
        name: 'NonMember',
        passwordHash: 'x',
      },
    });
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: owner.id, role: 'OWNER' },
    });
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    });
  });

  afterAll(async () => {
    await prisma.organizationInvite.deleteMany({ where: { organizationId: org.id } });
    await prisma.organizationMember.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, admin.id, nonMember.id] } } });
  });

  function makeRequest(body: object) {
    return new Request(`http://localhost/api/organizations/${org.id}/invites`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  it('returns 401 when signed out', async () => {
    currentSession = null;
    const res = await POST(makeRequest({ email: 'x@y.com', role: 'ADMIN' }), {
      params: Promise.resolve({ organizationId: org.id }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-member', async () => {
    currentSession = { user: { id: nonMember.id } };
    const res = await POST(makeRequest({ email: 'x@y.com', role: 'ADMIN' }), {
      params: Promise.resolve({ organizationId: org.id }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 403 when an ADMIN tries to invite an OWNER', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(makeRequest({ email: 'wannabe-owner@y.com', role: 'OWNER' }), {
      params: Promise.resolve({ organizationId: org.id }),
    });
    expect(res.status).toBe(403);
  });

  it('allows an ADMIN to invite another ADMIN', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await POST(makeRequest({ email: 'new-admin@y.com', role: 'ADMIN' }), {
      params: Promise.resolve({ organizationId: org.id }),
    });
    expect(res.status).toBe(201);
    const body: { id: string; token: string } = await res.json();
    expect(body.token).toBeTruthy();

    const invite = await prisma.organizationInvite.findUnique({ where: { id: body.id } });
    expect(invite?.status).toBe('PENDING');
    expect(invite?.email).toBe('new-admin@y.com');
    expect(invite?.role).toBe('ADMIN');
  });

  it('allows an OWNER to invite a new OWNER', async () => {
    currentSession = { user: { id: owner.id } };
    const res = await POST(makeRequest({ email: 'new-owner@y.com', role: 'OWNER' }), {
      params: Promise.resolve({ organizationId: org.id }),
    });
    expect(res.status).toBe(201);
    const body: { id: string; token: string } = await res.json();
    expect(body.token).toBeTruthy();

    const invite = await prisma.organizationInvite.findUnique({ where: { id: body.id } });
    expect(invite?.status).toBe('PENDING');
    expect(invite?.role).toBe('OWNER');
  });
});
