import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

interface InstalledPayload {
  key?: string;
  clientKey?: string;
  sharedSecret?: string;
  baseUrl?: string;
  displayUrl?: string;
  productType?: string;
}

function isValidPayload(body: unknown): body is InstalledPayload & {
  clientKey: string;
  sharedSecret: string;
  baseUrl: string;
} {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.clientKey === 'string' &&
    b.clientKey.length > 0 &&
    typeof b.sharedSecret === 'string' &&
    b.sharedSecret.length > 0 &&
    typeof b.baseUrl === 'string' &&
    b.baseUrl.length > 0
  );
}

// Atlassian Connect `installed` lifecycle callback (Issue 10.2). Fired once
// per Jira Cloud site the app is installed on — before any SpecMate workspace
// exists to associate it with (that association happens later, when an admin
// claims the install from a SpecMate settings page).
//
// Trust-on-first-use by design: there is no prior sharedSecret to verify this
// request against (this IS the request that establishes one), which is why
// Atlassian's own guidance is to treat this endpoint differently from every
// other Connect callback. `clientKey` is upserted (not just created) so a
// reinstall on the same site correctly rotates in the new sharedSecret rather
// than erroring on a duplicate-key conflict.
export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  if (!isValidPayload(body)) {
    return NextResponse.json({ error: 'Invalid installed payload.' }, { status: 400 });
  }

  await prisma.atlassianConnectInstall.upsert({
    where: { clientKey: body.clientKey },
    create: {
      clientKey: body.clientKey,
      sharedSecret: body.sharedSecret,
      baseUrl: body.baseUrl,
      displayUrl: body.displayUrl ?? null,
      productType: body.productType ?? null,
    },
    update: {
      sharedSecret: body.sharedSecret,
      baseUrl: body.baseUrl,
      displayUrl: body.displayUrl ?? null,
      productType: body.productType ?? null,
      uninstalledAt: null, // a reinstall un-cancels a previously-uninstalled site
    },
  });

  return NextResponse.json({ ok: true });
}
