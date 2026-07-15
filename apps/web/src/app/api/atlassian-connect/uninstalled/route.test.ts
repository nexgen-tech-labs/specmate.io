// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeSymmetric,
  SymmetricAlgorithm,
  fromMethodAndUrl,
  createQueryStringHash,
} from '@atlassian/atlassian-jwt';
import { prisma } from '@/lib/prisma';
import { POST } from './route';

function signedUninstallUrl(clientKey: string, secret: string): string {
  const url = 'http://localhost/api/atlassian-connect/uninstalled';
  const req = fromMethodAndUrl('POST', url);
  const qsh = createQueryStringHash(req, false);
  const token = encodeSymmetric({ iss: clientKey, qsh }, secret, SymmetricAlgorithm.HS256);
  return `${url}?jwt=${token}`;
}

describe('POST /api/atlassian-connect/uninstalled', () => {
  const clientKey = `test-uninstall-${Date.now()}`;
  const sharedSecret = 'the-real-shared-secret';

  afterEach(async () => {
    await prisma.atlassianConnectInstall.deleteMany({ where: { clientKey } });
  });

  it('marks a validly-JWT-signed uninstall as uninstalled', async () => {
    await prisma.atlassianConnectInstall.create({
      data: { clientKey, sharedSecret, baseUrl: 'https://acme.atlassian.net' },
    });

    const res = await POST(
      new Request(signedUninstallUrl(clientKey, sharedSecret), {
        method: 'POST',
        body: JSON.stringify({ clientKey }),
      }),
    );
    expect(res.status).toBe(200);

    const install = await prisma.atlassianConnectInstall.findUnique({ where: { clientKey } });
    expect(install?.uninstalledAt).not.toBeNull();
  });

  it('rejects a request signed with the wrong shared secret', async () => {
    await prisma.atlassianConnectInstall.create({
      data: { clientKey, sharedSecret, baseUrl: 'https://acme.atlassian.net' },
    });

    const res = await POST(
      new Request(signedUninstallUrl(clientKey, 'wrong-secret'), {
        method: 'POST',
        body: JSON.stringify({ clientKey }),
      }),
    );
    expect(res.status).toBe(401);

    const install = await prisma.atlassianConnectInstall.findUnique({ where: { clientKey } });
    expect(install?.uninstalledAt).toBeNull();
  });

  it('rejects a request with no jwt query parameter', async () => {
    await prisma.atlassianConnectInstall.create({
      data: { clientKey, sharedSecret, baseUrl: 'https://acme.atlassian.net' },
    });

    const res = await POST(
      new Request('http://localhost/api/atlassian-connect/uninstalled', {
        method: 'POST',
        body: JSON.stringify({ clientKey }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('is idempotent for an unknown clientKey (no error, no-op)', async () => {
    const res = await POST(
      new Request('http://localhost/api/atlassian-connect/uninstalled?jwt=whatever', {
        method: 'POST',
        body: JSON.stringify({ clientKey: 'never-existed' }),
      }),
    );
    expect(res.status).toBe(200);
  });
});
