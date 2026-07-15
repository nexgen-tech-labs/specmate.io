// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { POST } from './route';

describe('POST /api/atlassian-connect/installed', () => {
  const clientKey = `test-client-${Date.now()}`;

  afterEach(async () => {
    await prisma.atlassianConnectInstall.deleteMany({ where: { clientKey } });
  });

  it('creates an unclaimed install on first install', async () => {
    const res = await POST(
      new Request('http://localhost/api/atlassian-connect/installed', {
        method: 'POST',
        body: JSON.stringify({
          clientKey,
          sharedSecret: 'secret-1',
          baseUrl: 'https://acme.atlassian.net',
          displayUrl: 'https://acme.atlassian.net',
          productType: 'jira',
        }),
      }),
    );
    expect(res.status).toBe(200);

    const install = await prisma.atlassianConnectInstall.findUnique({ where: { clientKey } });
    expect(install).not.toBeNull();
    expect(install?.sharedSecret).toBe('secret-1');
    expect(install?.workspaceId).toBeNull();
  });

  it('rotates the sharedSecret and un-cancels on reinstall', async () => {
    await POST(
      new Request('http://localhost/api/atlassian-connect/installed', {
        method: 'POST',
        body: JSON.stringify({
          clientKey,
          sharedSecret: 'secret-1',
          baseUrl: 'https://acme.atlassian.net',
        }),
      }),
    );
    await prisma.atlassianConnectInstall.update({
      where: { clientKey },
      data: { uninstalledAt: new Date() },
    });

    await POST(
      new Request('http://localhost/api/atlassian-connect/installed', {
        method: 'POST',
        body: JSON.stringify({
          clientKey,
          sharedSecret: 'secret-2',
          baseUrl: 'https://acme.atlassian.net',
        }),
      }),
    );

    const install = await prisma.atlassianConnectInstall.findUnique({ where: { clientKey } });
    expect(install?.sharedSecret).toBe('secret-2');
    expect(install?.uninstalledAt).toBeNull();
  });

  it('rejects a payload missing required fields', async () => {
    const res = await POST(
      new Request('http://localhost/api/atlassian-connect/installed', {
        method: 'POST',
        body: JSON.stringify({ clientKey }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
