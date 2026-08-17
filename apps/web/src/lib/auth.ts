import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { prisma } from './prisma';
import { verifyPassword } from './password';
import { resolveOAuthSignIn, resolveUserIdForOAuthAccount } from './oauth-linking';

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Azure Container Apps terminates TLS and proxies requests internally
  // (the app itself only ever sees the container's internal hostname unless
  // this is set) — trustHost tells Auth.js to trust the Host header Container
  // Apps' ingress forwards, same role AUTH_URL/NEXTAUTH_URL would play if we
  // pinned a single fixed origin. Safe here because Container Apps' ingress
  // is the only thing that can set that header before it reaches this app.
  trustHost: true,
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
      authorize: async (credentials) => {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== 'string' || typeof password !== 'string') return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.passwordHash) return null;

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
    GitHub({
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      authorization: { params: { scope: 'read:user user:email' } },
      // GitHub's default profile() drops the /user/emails `verified` field
      // (confirmed by reading @auth/core's github.js source) — override to
      // preserve it, since it's the auto-link safety gate.
      async profile(profile, tokens) {
        let verified = false;
        let email = profile.email;
        const res = await fetch('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'authjs' },
        });
        if (res.ok) {
          const emails: Array<{ email: string; primary: boolean; verified: boolean }> =
            await res.json();
          const primary = emails.find((e) => e.primary) ?? emails[0];
          if (primary) {
            email = primary.email;
            verified = primary.verified;
          }
        }
        return {
          id: profile.id.toString(),
          name: profile.name ?? profile.login,
          email,
          image: profile.avatar_url,
          emailVerifiedByProvider: verified,
        };
      },
    }),
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: { params: { scope: 'openid email profile' } },
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email,
          image: profile.picture,
          emailVerifiedByProvider: Boolean(profile.email_verified),
        };
      },
    }),
    MicrosoftEntraID({
      clientId: process.env.MICROSOFT_ENTRA_ID_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_ENTRA_ID_CLIENT_SECRET,
      authorization: { params: { scope: 'openid email profile' } },
      // Default profile() fetches a profile photo (unnecessary for login-only
      // use) and drops any verification signal — override to skip the photo
      // fetch and treat an Entra ID email as provider-verified (Microsoft's
      // own account system requires verified email for org accounts).
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name,
          email: profile.email,
          image: null,
          emailVerifiedByProvider: true,
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      if (!account || account.provider === 'credentials') return true;

      const email = (profile as { email?: string } | undefined)?.email;
      const name = (profile as { name?: string } | undefined)?.name ?? email ?? 'New User';
      const emailVerifiedByProvider = Boolean(
        (profile as { emailVerifiedByProvider?: boolean } | undefined)?.emailVerifiedByProvider,
      );
      if (!email) return false;

      const result = await resolveOAuthSignIn({
        provider: account.provider,
        providerAccountId: account.providerAccountId,
        email,
        name,
        emailVerifiedByProvider,
      });
      if (result.outcome === 'blocked_existing_account') {
        return '/login?error=AccountExists';
      }
      return true;
    },
    async jwt({ token, user, account }) {
      if (account && account.provider !== 'credentials') {
        token.sub = await resolveUserIdForOAuthAccount(account.provider, account.providerAccountId);
      } else if (user) {
        token.sub = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
