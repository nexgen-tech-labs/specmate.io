import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', () => ({ auth: async () => currentSession }));

const { GET } = await import('./route');

describe('GET /api/account/connections', () => {
  let user: { id: string };
  let account: { id: string };

  beforeAll(async () => {
    user = await prisma.user.create({
      data: { email: `conn-test-${Date.now()}@test.local`, name: 'X', passwordHash: 'hashed' },
    });
    account = await prisma.account.create({
      data: { provider: 'github', providerAccountId: `gh-${Date.now()}`, userId: user.id },
    });
  });

  afterAll(async () => {
    await prisma.account.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  });

  it('returns 401 when signed out', async () => {
    currentSession = null;
    const res = await GET(new Request('http://localhost/api/account/connections'));
    expect(res.status).toBe(401);
  });

  it("returns the signed-in user's connected providers and whether they have a password", async () => {
    currentSession = { user: { id: user.id } };
    const res = await GET(new Request('http://localhost/api/account/connections'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts).toContainEqual(
      expect.objectContaining({ id: account.id, provider: 'github' }),
    );
    expect(body.hasPassword).toBe(true);
  });
});
