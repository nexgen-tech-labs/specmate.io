// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { PATCH } = await import('./route');

/**
 * Organization settings update endpoint (Issue #99 Task 4): PATCH
 * /api/organizations/{organizationId}. OWNER-only (billing/org settings
 * split documented in workspace-context.ts).
 */
describe('PATCH /api/organizations/[organizationId] (Issue #99)', () => {
  let organization: { id: string };
  let owner: { id: string };
  let admin: { id: string };

  beforeAll(async () => {
    const stamp = Date.now();
    organization = await prisma.organization.create({
      data: { name: `Settings Org ${stamp}`, size: 'SMALL' },
    });
    [owner, admin] = await Promise.all(
      ['owner', 'admin'].map((tag) =>
        prisma.user.create({
          data: { email: `org-settings-${tag}-${stamp}@test.local`, name: tag, passwordHash: 'x' },
        }),
      ),
    );
    await prisma.organizationMember.createMany({
      data: [
        { organizationId: organization.id, userId: owner.id, role: 'OWNER' },
        { organizationId: organization.id, userId: admin.id, role: 'ADMIN' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.organizationMember.deleteMany({ where: { organizationId: organization.id } });
    await prisma.organization.deleteMany({ where: { id: organization.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, admin.id] } } });
  });

  function orgParams() {
    return { params: Promise.resolve({ organizationId: organization.id }) };
  }

  it('rejects unauthenticated requests with 401', async () => {
    currentSession = null;
    const res = await PATCH(
      new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ name: 'X' }) }),
      orgParams(),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a non-OWNER (including org ADMIN) with 403', async () => {
    currentSession = { user: { id: admin.id } };
    const res = await PATCH(
      new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ name: 'Nope' }) }),
      orgParams(),
    );
    expect(res.status).toBe(403);
  });

  it('updates name only', async () => {
    currentSession = { user: { id: owner.id } };
    const res = await PATCH(
      new Request('http://localhost', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Renamed Org' }),
      }),
      orgParams(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; size: string | null };
    expect(body.name).toBe('Renamed Org');

    const fresh = await prisma.organization.findUnique({ where: { id: organization.id } });
    expect(fresh?.name).toBe('Renamed Org');
    expect(fresh?.size).toBe('SMALL');
  });

  it('updates size only', async () => {
    currentSession = { user: { id: owner.id } };
    const res = await PATCH(
      new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ size: 'LARGE' }) }),
      orgParams(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; size: string | null };
    expect(body.size).toBe('LARGE');

    const fresh = await prisma.organization.findUnique({ where: { id: organization.id } });
    expect(fresh?.size).toBe('LARGE');
    expect(fresh?.name).toBe('Renamed Org');
  });

  it('updates both name and size together', async () => {
    currentSession = { user: { id: owner.id } };
    const res = await PATCH(
      new Request('http://localhost', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Both Update', size: 'ENTERPRISE' }),
      }),
      orgParams(),
    );
    expect(res.status).toBe(200);

    const fresh = await prisma.organization.findUnique({ where: { id: organization.id } });
    expect(fresh?.name).toBe('Both Update');
    expect(fresh?.size).toBe('ENTERPRISE');
  });

  it('returns 400 when neither valid field is provided', async () => {
    currentSession = { user: { id: owner.id } };
    const res = await PATCH(
      new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ foo: 'bar' }) }),
      orgParams(),
    );
    expect(res.status).toBe(400);
  });
});
