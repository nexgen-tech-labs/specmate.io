import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { id: string } } | null = null;
vi.mock('@/lib/auth', () => ({ auth: async () => currentSession }));

const { DELETE } = await import('./route');

function makeRequest() {
  return new Request('http://localhost/api/account/connections/x', { method: 'DELETE' });
}

describe('DELETE /api/account/connections/[accountId]', () => {
  let userWithPassword: { id: string };
  let userWithoutPasswordMultiAccount: { id: string };
  let userWithoutPasswordSingleAccount: { id: string };
  let otherUser: { id: string };

  let accountOfUserWithPassword: { id: string };
  let accountA: { id: string };
  let accountB: { id: string };
  let soleAccount: { id: string };
  let accountOfOtherUser: { id: string };

  beforeAll(async () => {
    userWithPassword = await prisma.user.create({
      data: { email: `del-pw-${Date.now()}@test.local`, name: 'A', passwordHash: 'hashed' },
    });
    userWithoutPasswordMultiAccount = await prisma.user.create({
      data: { email: `del-multi-${Date.now()}@test.local`, name: 'B', passwordHash: null },
    });
    userWithoutPasswordSingleAccount = await prisma.user.create({
      data: { email: `del-single-${Date.now()}@test.local`, name: 'C', passwordHash: null },
    });
    otherUser = await prisma.user.create({
      data: { email: `del-other-${Date.now()}@test.local`, name: 'D', passwordHash: 'hashed' },
    });

    accountOfUserWithPassword = await prisma.account.create({
      data: {
        provider: 'github',
        providerAccountId: `gh-pw-${Date.now()}`,
        userId: userWithPassword.id,
      },
    });
    accountA = await prisma.account.create({
      data: {
        provider: 'github',
        providerAccountId: `gh-a-${Date.now()}`,
        userId: userWithoutPasswordMultiAccount.id,
      },
    });
    accountB = await prisma.account.create({
      data: {
        provider: 'google',
        providerAccountId: `g-b-${Date.now()}`,
        userId: userWithoutPasswordMultiAccount.id,
      },
    });
    soleAccount = await prisma.account.create({
      data: {
        provider: 'github',
        providerAccountId: `gh-sole-${Date.now()}`,
        userId: userWithoutPasswordSingleAccount.id,
      },
    });
    accountOfOtherUser = await prisma.account.create({
      data: {
        provider: 'github',
        providerAccountId: `gh-other-${Date.now()}`,
        userId: otherUser.id,
      },
    });
  });

  afterAll(async () => {
    const userIds = [
      userWithPassword.id,
      userWithoutPasswordMultiAccount.id,
      userWithoutPasswordSingleAccount.id,
      otherUser.id,
    ];
    await prisma.account.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it('returns 401 when signed out', async () => {
    currentSession = null;
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ accountId: accountOfUserWithPassword.id }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for an accountId belonging to a different user', async () => {
    currentSession = { user: { id: userWithPassword.id } };
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ accountId: accountOfOtherUser.id }),
    });
    expect(res.status).toBe(404);

    const stillThere = await prisma.account.findUnique({ where: { id: accountOfOtherUser.id } });
    expect(stillThere).not.toBeNull();
  });

  it('unlinks successfully when the user has a password', async () => {
    currentSession = { user: { id: userWithPassword.id } };
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ accountId: accountOfUserWithPassword.id }),
    });
    expect(res.status).toBe(200);

    const gone = await prisma.account.findUnique({ where: { id: accountOfUserWithPassword.id } });
    expect(gone).toBeNull();
  });

  it('unlinks successfully when the user has no password but has more than one linked account', async () => {
    currentSession = { user: { id: userWithoutPasswordMultiAccount.id } };
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ accountId: accountA.id }),
    });
    expect(res.status).toBe(200);

    const gone = await prisma.account.findUnique({ where: { id: accountA.id } });
    expect(gone).toBeNull();
    const remains = await prisma.account.findUnique({ where: { id: accountB.id } });
    expect(remains).not.toBeNull();
  });

  it('returns 409 and does not delete when it is the only sign-in method', async () => {
    currentSession = { user: { id: userWithoutPasswordSingleAccount.id } };
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ accountId: soleAccount.id }),
    });
    expect(res.status).toBe(409);

    const stillThere = await prisma.account.findUnique({ where: { id: soleAccount.id } });
    expect(stillThere).not.toBeNull();
  });
});
