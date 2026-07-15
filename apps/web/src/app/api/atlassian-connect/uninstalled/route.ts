import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ConnectJwtError, verifyConnectJwt } from '@/lib/atlassian-connect';

interface UninstalledPayload {
  clientKey?: string;
}

// Atlassian Connect `uninstalled` lifecycle callback (Issue 10.2). Unlike
// `installed`, a sharedSecret already exists for this site by the time this
// fires — so this MUST be JWT-verified against the *stored* secret, not
// trusted on first use. A forged uninstall request without a valid JWT is
// rejected before touching the database.
export async function POST(request: Request) {
  const url = new URL(request.url);
  const jwt = url.searchParams.get('jwt');
  const rawBody = await request.text();

  let body: UninstalledPayload;
  try {
    body = JSON.parse(rawBody) as UninstalledPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  if (!body.clientKey) {
    return NextResponse.json({ error: 'Missing clientKey.' }, { status: 400 });
  }
  if (!jwt) {
    return NextResponse.json({ error: 'Missing jwt query parameter.' }, { status: 401 });
  }

  const install = await prisma.atlassianConnectInstall.findUnique({
    where: { clientKey: body.clientKey },
  });
  if (!install) {
    // Nothing to uninstall — not an error (idempotent: Atlassian may retry).
    return NextResponse.json({ ok: true });
  }

  try {
    verifyConnectJwt(jwt, install.sharedSecret, request.method, request.url);
  } catch (err) {
    if (err instanceof ConnectJwtError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  await prisma.atlassianConnectInstall.update({
    where: { clientKey: body.clientKey },
    data: { uninstalledAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
