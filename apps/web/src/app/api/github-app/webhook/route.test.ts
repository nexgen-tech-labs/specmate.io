// @vitest-environment node
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST } from './route';

const SECRET = 'test-webhook-secret';
const installationId = 900000000 + Math.floor(Math.random() * 90000000);

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
}

function makeRequest(event: string, body: unknown): Request {
  const rawBody = JSON.stringify(body);
  return new Request('http://localhost/api/github-app/webhook', {
    method: 'POST',
    headers: {
      'x-github-event': event,
      'x-hub-signature-256': sign(rawBody),
    },
    body: rawBody,
  });
}

describe('POST /api/github-app/webhook', () => {
  const originalSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
  });

  afterEach(async () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = originalSecret;
    await prisma.gitHubAppInstall.deleteMany({ where: { installationId } });
  });

  it('returns 503 when the webhook secret is not configured', async () => {
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    const res = await POST(
      makeRequest('installation', { action: 'created', installation: { id: installationId } }),
    );
    expect(res.status).toBe(503);
  });

  it('rejects a request with an invalid signature', async () => {
    const rawBody = JSON.stringify({ action: 'created', installation: { id: installationId } });
    const res = await POST(
      new Request('http://localhost/api/github-app/webhook', {
        method: 'POST',
        headers: { 'x-github-event': 'installation', 'x-hub-signature-256': 'sha256=deadbeef' },
        body: rawBody,
      }),
    );
    expect(res.status).toBe(401);
  });

  it('ignores an event type it does not subscribe to', async () => {
    const res = await POST(makeRequest('push', { ref: 'refs/heads/main' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ignored?: string };
    expect(body.ignored).toBe('push');
  });

  it('creates an unclaimed install on the created action', async () => {
    const res = await POST(
      makeRequest('installation', {
        action: 'created',
        installation: {
          id: installationId,
          account: { login: 'acme-corp', type: 'Organization' },
          repository_selection: 'all',
        },
      }),
    );
    expect(res.status).toBe(200);

    const install = await prisma.gitHubAppInstall.findUnique({
      where: { installationId: BigInt(installationId) },
    });
    expect(install).not.toBeNull();
    expect(install?.accountLogin).toBe('acme-corp');
    expect(install?.workspaceId).toBeNull();
  });

  it('marks an install uninstalled on the deleted action', async () => {
    await prisma.gitHubAppInstall.create({
      data: {
        installationId: BigInt(installationId),
        accountLogin: 'acme-corp',
        accountType: 'Organization',
        repositorySelection: 'all',
      },
    });

    const res = await POST(
      makeRequest('installation', { action: 'deleted', installation: { id: installationId } }),
    );
    expect(res.status).toBe(200);

    const install = await prisma.gitHubAppInstall.findUnique({
      where: { installationId: BigInt(installationId) },
    });
    expect(install?.uninstalledAt).not.toBeNull();
  });

  it('marks an install suspended on the suspend action, and clears it on unsuspend', async () => {
    await prisma.gitHubAppInstall.create({
      data: {
        installationId: BigInt(installationId),
        accountLogin: 'acme-corp',
        accountType: 'Organization',
        repositorySelection: 'all',
      },
    });

    await POST(
      makeRequest('installation', { action: 'suspend', installation: { id: installationId } }),
    );
    let install = await prisma.gitHubAppInstall.findUnique({
      where: { installationId: BigInt(installationId) },
    });
    expect(install?.suspendedAt).not.toBeNull();

    await POST(
      makeRequest('installation', { action: 'unsuspend', installation: { id: installationId } }),
    );
    install = await prisma.gitHubAppInstall.findUnique({
      where: { installationId: BigInt(installationId) },
    });
    expect(install?.suspendedAt).toBeNull();
  });

  it('un-cancels a previously uninstalled row on reinstall', async () => {
    await prisma.gitHubAppInstall.create({
      data: {
        installationId: BigInt(installationId),
        accountLogin: 'acme-corp',
        accountType: 'Organization',
        repositorySelection: 'all',
        uninstalledAt: new Date(),
      },
    });

    const res = await POST(
      makeRequest('installation', {
        action: 'created',
        installation: {
          id: installationId,
          account: { login: 'acme-corp', type: 'Organization' },
          repository_selection: 'selected',
        },
      }),
    );
    expect(res.status).toBe(200);

    const install = await prisma.gitHubAppInstall.findUnique({
      where: { installationId: BigInt(installationId) },
    });
    expect(install?.uninstalledAt).toBeNull();
    expect(install?.repositorySelection).toBe('selected');
  });

  it('rejects a payload missing installation.id', async () => {
    const res = await POST(makeRequest('installation', { action: 'created' }));
    expect(res.status).toBe(400);
  });
});
