import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  GitHubWebhookSignatureError,
  verifyGitHubWebhookSignature,
} from '@/lib/github-app-webhook';

interface InstallationAccount {
  login?: string;
  type?: string;
}

interface InstallationPayload {
  action?: string;
  installation?: {
    id?: number;
    account?: InstallationAccount;
    repository_selection?: string;
  };
}

// GitHub App installation lifecycle webhook (Issue 10.3) — fired for
// `installation` events (created/deleted/suspend/unsuspend/new_permissions_accepted)
// and `installation_repositories` (added/removed repos under an existing
// install, which doesn't change identity so is a no-op here beyond
// refreshing repositorySelection). Unlike Atlassian Connect's `installed`
// callback, EVERY GitHub webhook delivery — including the very first one —
// carries a verifiable HMAC signature (the webhook secret is configured once
// at App registration, not minted per-install), so there's no
// trust-on-first-use window here at all.
export async function POST(request: Request) {
  const rawBody = await request.text();
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'GitHub App webhook is not configured.' }, { status: 503 });
  }

  try {
    verifyGitHubWebhookSignature(rawBody, request.headers.get('x-hub-signature-256'), secret);
  } catch (err) {
    if (err instanceof GitHubWebhookSignatureError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const event = request.headers.get('x-github-event');
  let body: InstallationPayload;
  try {
    body = JSON.parse(rawBody) as InstallationPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  // Only installation identity/lifecycle events are handled here — GitHub
  // sends many other event types (issues, push, etc.) to the same webhook
  // URL by default if the App subscribes to them; none of those are
  // subscribed to today, but a stray delivery should no-op cleanly rather
  // than error.
  if (event !== 'installation' && event !== 'installation_repositories') {
    return NextResponse.json({ ok: true, ignored: event });
  }

  const installation = body.installation;
  if (!installation?.id) {
    return NextResponse.json({ error: 'Missing installation.id.' }, { status: 400 });
  }
  const installationId = BigInt(installation.id);

  if (body.action === 'deleted') {
    await prisma.gitHubAppInstall.updateMany({
      where: { installationId },
      data: { uninstalledAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  }
  if (body.action === 'suspend') {
    await prisma.gitHubAppInstall.updateMany({
      where: { installationId },
      data: { suspendedAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  }
  if (body.action === 'unsuspend') {
    await prisma.gitHubAppInstall.updateMany({
      where: { installationId },
      data: { suspendedAt: null },
    });
    return NextResponse.json({ ok: true });
  }

  // `created` (first install) and `new_permissions_accepted`/
  // `installation_repositories` (repo selection changed) all upsert the
  // same identity fields — a reinstall or a repo-scope change un-cancels a
  // previously-uninstalled row rather than erroring on the unique
  // constraint, mirroring atlassian-connect/installed's reinstall handling.
  await prisma.gitHubAppInstall.upsert({
    where: { installationId },
    create: {
      installationId,
      accountLogin: installation.account?.login ?? '',
      accountType: installation.account?.type ?? '',
      repositorySelection: installation.repository_selection ?? '',
    },
    update: {
      accountLogin: installation.account?.login ?? '',
      accountType: installation.account?.type ?? '',
      repositorySelection: installation.repository_selection ?? '',
      uninstalledAt: null,
    },
  });

  return NextResponse.json({ ok: true });
}
