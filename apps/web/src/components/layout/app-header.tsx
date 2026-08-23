import Link from 'next/link';
import { auth, signOut } from '@/lib/auth';

export async function AppHeader() {
  const session = await auth();
  const user = session?.user;

  return (
    <header className="border-b border-line bg-panel">
      <div className="mx-auto flex max-w-[1120px] items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-3">
          <div className="grid size-8 place-items-center rounded bg-cobalt font-mono text-sm font-bold text-white">
            S
          </div>
          <span className="text-lg font-bold tracking-tight text-ink">SpecMate</span>
        </Link>

        {user ? (
          <div className="flex items-center gap-3">
            <Link
              href="/settings/account"
              className="rounded-md border border-line bg-transparent px-4 py-2.5 font-mono text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
            >
              {user.name ?? user.email ?? 'Account'}
            </Link>
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/' });
              }}
            >
              <button
                type="submit"
                className="rounded-md bg-ink px-5 py-2.5 font-mono text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
              >
                Sign Out
              </button>
            </form>
          </div>
        ) : (
          <div className="flex gap-3">
            <Link
              href="/login"
              className="rounded-md border border-line bg-transparent px-4 py-2.5 font-mono text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-cobalt"
            >
              Sign In
            </Link>
            <Link
              href="/onboarding"
              className="rounded-md bg-cobalt px-5 py-2.5 font-mono text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
            >
              Get Started
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
