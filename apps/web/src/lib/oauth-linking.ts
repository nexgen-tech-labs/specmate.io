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
  // Providers aren't guaranteed to normalize email casing consistently
  // (existing /api/signup has the same gap for password signups) — lowercase
  // here so an OAuth sign-in reliably matches an existing account regardless
  // of casing, rather than silently creating a duplicate User.
  const email = input.email.toLowerCase();

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

  const matchingUser = await prisma.user.findUnique({ where: { email } });

  if (!matchingUser) {
    let user;
    try {
      ({ user } = await createTenantForNewUser({
        name: input.name,
        email,
        passwordHash: null,
        orgName: `${input.name}'s Organization`,
        orgSize: 'SOLO',
        workspaceName: `${input.name}'s Workspace`,
      }));
    } catch (err) {
      // Two concurrent sign-ins for the same brand-new email (double-click,
      // two tabs) can both pass the !matchingUser check above — the loser
      // hits User.email's unique constraint. Recover by re-resolving against
      // the row the winner just created, rather than surfacing a raw 500.
      if (isUniqueConstraintViolation(err)) {
        const winner = await prisma.user.findUnique({ where: { email } });
        if (winner) return linkOrReuseAccount(input.provider, input.providerAccountId, winner.id);
      }
      throw err;
    }
    return linkOrReuseAccount(input.provider, input.providerAccountId, user.id, {
      markVerified: input.emailVerifiedByProvider,
    });
  }

  if (input.emailVerifiedByProvider) {
    return linkOrReuseAccount(input.provider, input.providerAccountId, matchingUser.id);
  }

  return { outcome: 'blocked_existing_account' };
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

// Creates the Account row for a resolved userId, tolerating the case where a
// concurrent request already created it (same double-click/two-tab race as
// above, but on Account's (provider, providerAccountId) unique constraint
// instead of User.email).
async function linkOrReuseAccount(
  provider: string,
  providerAccountId: string,
  userId: string,
  options?: { markVerified?: boolean },
): Promise<ResolveOAuthSignInResult> {
  try {
    await prisma.account.create({ data: { provider, providerAccountId, userId } });
  } catch (err) {
    if (!isUniqueConstraintViolation(err)) throw err;
  }
  if (options?.markVerified) {
    await prisma.user.update({ where: { id: userId }, data: { emailVerified: new Date() } });
  }
  return { outcome: 'signed_in', userId };
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
