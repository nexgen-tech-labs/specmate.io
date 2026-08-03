import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from './prisma';
import { resolveOAuthSignIn, resolveUserIdForOAuthAccount } from './oauth-linking';

describe('resolveOAuthSignIn', () => {
  const createdUserIds: string[] = [];
  const createdWorkspaceIds: string[] = [];
  const createdOrgIds: string[] = [];
  const createdAccountIds: string[] = [];

  afterEach(async () => {
    await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
    await prisma.workspaceMember.deleteMany({
      where: { workspaceId: { in: createdWorkspaceIds } },
    });
    await prisma.organizationMember.deleteMany({
      where: { organizationId: { in: createdOrgIds } },
    });
    await prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdAccountIds.length = 0;
    createdUserIds.length = 0;
    createdWorkspaceIds.length = 0;
    createdOrgIds.length = 0;
  });

  it('creates a new User + Account + tenant when no existing Account or matching email exists', async () => {
    const email = `oauth-new-${Date.now()}@test.local`;
    const result = await resolveOAuthSignIn({
      provider: 'github',
      providerAccountId: `gh-${Date.now()}`,
      email,
      name: 'New OAuth User',
      emailVerifiedByProvider: true,
    });
    expect(result.outcome).toBe('signed_in');
    if (result.outcome === 'signed_in') {
      createdUserIds.push(result.userId);
      const account = await prisma.account.findFirstOrThrow({ where: { userId: result.userId } });
      createdAccountIds.push(account.id);
      const membership = await prisma.workspaceMember.findFirstOrThrow({
        where: { userId: result.userId },
      });
      createdWorkspaceIds.push(membership.workspaceId);
      const orgMembership = await prisma.organizationMember.findFirstOrThrow({
        where: { userId: result.userId },
      });
      createdOrgIds.push(orgMembership.organizationId);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
      expect(user.passwordHash).toBeNull();
      expect(user.emailVerified).not.toBeNull();
    }
  });

  it('creates a new User with emailVerified null when the provider does NOT assert verification', async () => {
    const email = `oauth-new-unverified-${Date.now()}@test.local`;
    const result = await resolveOAuthSignIn({
      provider: 'github',
      providerAccountId: `gh-unverified-${Date.now()}`,
      email,
      name: 'New Unverified User',
      emailVerifiedByProvider: false,
    });
    expect(result.outcome).toBe('signed_in');
    if (result.outcome === 'signed_in') {
      createdUserIds.push(result.userId);
      const account = await prisma.account.findFirstOrThrow({ where: { userId: result.userId } });
      createdAccountIds.push(account.id);
      const membership = await prisma.workspaceMember.findFirstOrThrow({
        where: { userId: result.userId },
      });
      createdWorkspaceIds.push(membership.workspaceId);
      const orgMembership = await prisma.organizationMember.findFirstOrThrow({
        where: { userId: result.userId },
      });
      createdOrgIds.push(orgMembership.organizationId);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
      expect(user.emailVerified).toBeNull();
    }
  });

  it('returns the existing userId when the (provider, providerAccountId) Account already exists — idempotent re-sign-in', async () => {
    const email = `oauth-existing-${Date.now()}@test.local`;
    const providerAccountId = `gh-${Date.now()}`;
    const first = await resolveOAuthSignIn({
      provider: 'github',
      providerAccountId,
      email,
      name: 'X',
      emailVerifiedByProvider: true,
    });
    expect(first.outcome).toBe('signed_in');
    if (first.outcome === 'signed_in') {
      createdUserIds.push(first.userId);
      const acct = await prisma.account.findFirstOrThrow({ where: { userId: first.userId } });
      createdAccountIds.push(acct.id);
      const membership = await prisma.workspaceMember.findFirstOrThrow({
        where: { userId: first.userId },
      });
      createdWorkspaceIds.push(membership.workspaceId);
      const orgMembership = await prisma.organizationMember.findFirstOrThrow({
        where: { userId: first.userId },
      });
      createdOrgIds.push(orgMembership.organizationId);
    }

    const second = await resolveOAuthSignIn({
      provider: 'github',
      providerAccountId,
      email,
      name: 'X',
      emailVerifiedByProvider: true,
    });
    expect(second.outcome).toBe('signed_in');
    if (second.outcome === 'signed_in' && first.outcome === 'signed_in') {
      expect(second.userId).toBe(first.userId);
    }
    // Confirm no duplicate Account or User was created on the second call.
    const accountCount = await prisma.account.count({
      where: { provider: 'github', providerAccountId },
    });
    expect(accountCount).toBe(1);
  });

  it('auto-links to an existing password-based User when the provider asserts the email is verified', async () => {
    const email = `oauth-link-${Date.now()}@test.local`;
    const existingUser = await prisma.user.create({
      data: { name: 'Existing', email, passwordHash: 'hashed' },
    });
    createdUserIds.push(existingUser.id);

    const result = await resolveOAuthSignIn({
      provider: 'google',
      providerAccountId: `g-${Date.now()}`,
      email,
      name: 'Existing',
      emailVerifiedByProvider: true,
    });
    expect(result.outcome).toBe('signed_in');
    if (result.outcome === 'signed_in') {
      expect(result.userId).toBe(existingUser.id);
      const account = await prisma.account.findFirstOrThrow({ where: { userId: existingUser.id } });
      createdAccountIds.push(account.id);
    }
    // Confirm NO duplicate User was created — exactly one User with this email.
    const userCount = await prisma.user.count({ where: { email } });
    expect(userCount).toBe(1);
  });

  it('rejects sign-in when a matching User exists but the provider does not assert the email is verified — no Account created', async () => {
    const email = `oauth-reject-${Date.now()}@test.local`;
    const existingUser = await prisma.user.create({
      data: { name: 'Existing', email, passwordHash: 'hashed' },
    });
    createdUserIds.push(existingUser.id);

    const result = await resolveOAuthSignIn({
      provider: 'microsoft-entra-id',
      providerAccountId: `m-${Date.now()}`,
      email,
      name: 'Existing',
      emailVerifiedByProvider: false,
    });
    expect(result.outcome).toBe('blocked_existing_account');

    const accounts = await prisma.account.findMany({ where: { userId: existingUser.id } });
    expect(accounts).toHaveLength(0); // no Account was created — nothing was linked

    const userCount = await prisma.user.count({ where: { email } });
    expect(userCount).toBe(1); // no duplicate User created either
  });

  it('two different providers can each independently link to the same existing verified-email User', async () => {
    const email = `oauth-multi-link-${Date.now()}@test.local`;
    const existingUser = await prisma.user.create({
      data: { name: 'Existing', email, passwordHash: 'hashed' },
    });
    createdUserIds.push(existingUser.id);

    const githubResult = await resolveOAuthSignIn({
      provider: 'github',
      providerAccountId: `gh-multi-${Date.now()}`,
      email,
      name: 'Existing',
      emailVerifiedByProvider: true,
    });
    const googleResult = await resolveOAuthSignIn({
      provider: 'google',
      providerAccountId: `g-multi-${Date.now()}`,
      email,
      name: 'Existing',
      emailVerifiedByProvider: true,
    });
    expect(githubResult.outcome).toBe('signed_in');
    expect(googleResult.outcome).toBe('signed_in');
    if (githubResult.outcome === 'signed_in' && googleResult.outcome === 'signed_in') {
      expect(githubResult.userId).toBe(existingUser.id);
      expect(googleResult.userId).toBe(existingUser.id);
    }
    const accounts = await prisma.account.findMany({ where: { userId: existingUser.id } });
    createdAccountIds.push(...accounts.map((a) => a.id));
    expect(accounts).toHaveLength(2);
  });
});

describe('resolveUserIdForOAuthAccount', () => {
  it('resolves the correct internal userId for an existing linked Account', async () => {
    const user = await prisma.user.create({
      data: { name: 'X', email: `resolve-test-${Date.now()}@test.local`, passwordHash: null },
    });
    const providerAccountId = `gh-resolve-${Date.now()}`;
    const account = await prisma.account.create({
      data: { provider: 'github', providerAccountId, userId: user.id },
    });

    const resolved = await resolveUserIdForOAuthAccount('github', providerAccountId);
    expect(resolved).toBe(user.id);

    await prisma.account.delete({ where: { id: account.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});
