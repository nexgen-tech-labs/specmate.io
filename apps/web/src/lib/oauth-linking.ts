/**
 * OAuth account-linking logic (Issue 12.8), extracted from the auth.ts
 * signIn callback into directly-testable functions — NextAuth's internal
 * callback plumbing (verified against @auth/core@0.41.2's source) isn't
 * easily invokable in isolation, so the actual DB decisions live here.
 *
 * Security-critical: auto-linking an OAuth identity to an existing
 * email/password account is ONLY safe when the OAuth provider itself
 * asserts the email is verified — otherwise anyone who knows a victim's
 * email address could potentially create an OAuth account with that same
 * (unverified) email and get silently merged into the victim's account.
 */
import { prisma } from './prisma';
import { createTenantForNewUser } from './create-tenant';

interface ResolveOAuthSignInInput {
  provider: string;
  providerAccountId: string;
  email: string;
  name: string;
  emailVerifiedByProvider: boolean;
}

type ResolveOAuthSignInResult =
  { outcome: 'signed_in'; userId: string } | { outcome: 'blocked_existing_account' };

export async function resolveOAuthSignIn(
  input: ResolveOAuthSignInInput,
): Promise<ResolveOAuthSignInResult> {
  const existingAccount = await prisma.account.findUnique({
    where: {
      provider_providerAccountId: {
        provider: input.provider,
        providerAccountId: input.providerAccountId,
      },
    },
  });
  if (existingAccount) {
    return { outcome: 'signed_in', userId: existingAccount.userId };
  }

  const matchingUser = await prisma.user.findUnique({ where: { email: input.email } });

  if (!matchingUser) {
    const { user } = await createTenantForNewUser({
      name: input.name,
      email: input.email,
      passwordHash: null,
      orgName: `${input.name}'s Organization`,
      orgSize: 'SOLO',
      workspaceName: `${input.name}'s Workspace`,
    });
    await prisma.account.create({
      data: {
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        userId: user.id,
      },
    });
    if (input.emailVerifiedByProvider) {
      await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } });
    }
    return { outcome: 'signed_in', userId: user.id };
  }

  if (input.emailVerifiedByProvider) {
    await prisma.account.create({
      data: {
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        userId: matchingUser.id,
      },
    });
    return { outcome: 'signed_in', userId: matchingUser.id };
  }

  return { outcome: 'blocked_existing_account' };
}

/** Used by the jwt callback to resolve the internal User.id for an OAuth
 * sign-in, since (per @auth/core's no-adapter behavior) the `user` object
 * jwt() receives is the raw provider profile, not our database user. */
export async function resolveUserIdForOAuthAccount(
  provider: string,
  providerAccountId: string,
): Promise<string> {
  const account = await prisma.account.findUniqueOrThrow({
    where: { provider_providerAccountId: { provider, providerAccountId } },
  });
  return account.userId;
}
