import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

// Defense-in-depth redirect only — the real auth check on every mutation lives
// in workspace-context.ts (getCurrentWorkspaceMembership / requireWorkspaceRole),
// called from each route handler / server component. Do not rely on this alone.
export const proxy = auth((req) => {
  const isAuthed = !!req.auth?.user;
  if (!isAuthed) {
    const loginUrl = new URL('/login', req.nextUrl.origin);
    loginUrl.searchParams.set('callbackUrl', req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
});

export const config = {
  matcher: ['/workspaces/:path*', '/internal/:path*'],
  runtime: 'nodejs',
};
