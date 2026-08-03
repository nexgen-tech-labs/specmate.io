// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string; email: string } } | null = null;
vi.mock('@/lib/auth', () => ({ auth: async () => currentSession }));

const { POST } = await import('./route');

describe('POST /api/organization-invites/[token]/accept', () => {
  let org: { id: string };
  let admin: { id: string; email: string };
  let invitee: { id: string; email: string };

  beforeEach(async () => {
    const stamp = Date.now();
    org = await prisma.organization.create({ data: { name: 'Accept Org Test' } });
    admin = await prisma.user.create({
      data: { email: `org-accept-admin-${stamp}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    invitee = await prisma.user.create({
      data: { email: `org-accept-invitee-${stamp}@test.local`, name: 'Invitee', passwordHash: 'x' },
    });
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: admin.id, role: 'OWNER' },
    });
  });

  afterEach(async () => {
    await prisma.organizationInvite.deleteMany({ where: { organizationId: org.id } });
    await prisma.organizationMember.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, invitee.id] } } });
  });

  async function makeInvite(
    overrides: { expiresAt?: Date; status?: 'PENDING' | 'ACCEPTED' | 'REVOKED' } = {},
  ) {
    return prisma.organizationInvite.create({
      data: {
        organizationId: org.id,
        email: invitee.email,
        role: 'ADMIN',
        token: `org-test-token-${Date.now()}-${Math.random()}`,
        invitedByUserId: admin.id,
        expiresAt: new Date(Date.now() + 60_000),
        ...overrides,
      },
    });
  }

  function makeRequest(token: string) {
    return POST(new Request('http://localhost', { method: 'POST' }), {
      params: Promise.resolve({ token }),
    });
  }

  it('returns 401 when signed out', async () => {
    currentSession = null;
    const invite = await makeInvite();
    const res = await makeRequest(invite.token);
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown token', async () => {
    currentSession = { user: { id: invitee.id, email: invitee.email } };
    const res = await makeRequest('does-not-exist');
    expect(res.status).toBe(404);
  });

  it('returns 404 for an expired invite', async () => {
    currentSession = { user: { id: invitee.id, email: invitee.email } };
    const invite = await makeInvite({ expiresAt: new Date(Date.now() - 60_000) });
    const res = await makeRequest(invite.token);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-PENDING invite', async () => {
    currentSession = { user: { id: invitee.id, email: invitee.email } };
    const invite = await makeInvite({ status: 'ACCEPTED' });
    const res = await makeRequest(invite.token);
    expect(res.status).toBe(404);
  });

  it('returns 403 when the signed-in email does not match the invite', async () => {
    currentSession = { user: { id: admin.id, email: admin.email } };
    const invite = await makeInvite();
    const res = await makeRequest(invite.token);
    expect(res.status).toBe(403);
  });

  it('returns 200 and creates the membership on the happy path', async () => {
    currentSession = { user: { id: invitee.id, email: invitee.email } };
    const invite = await makeInvite();
    const res = await makeRequest(invite.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organizationId: string };
    expect(body.organizationId).toBe(org.id);

    const membership = await prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: invitee.id } },
    });
    expect(membership).not.toBeNull();
    expect(membership?.role).toBe('ADMIN');

    const refreshedInvite = await prisma.organizationInvite.findUnique({
      where: { id: invite.id },
    });
    expect(refreshedInvite?.status).toBe('ACCEPTED');
  });

  it('returns 409 when the user is already a member of the organization', async () => {
    currentSession = { user: { id: invitee.id, email: invitee.email } };
    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: invitee.id, role: 'ADMIN' },
    });
    const invite = await makeInvite();
    const res = await makeRequest(invite.token);
    expect(res.status).toBe(409);

    const refreshedInvite = await prisma.organizationInvite.findUnique({
      where: { id: invite.id },
    });
    expect(refreshedInvite?.status).toBe('PENDING');
  });
});
