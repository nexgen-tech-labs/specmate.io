// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';

const { POST } = await import('./route');

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/access-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    email: `founder-${Date.now()}-${Math.random()}@acmecorp.com`,
    companyName: 'Acme Corp',
    companySize: 'SMALL',
    howHeard: 'Saw it on LinkedIn',
    ...overrides,
  };
}

describe('POST /api/access-requests', () => {
  const createdEmails: string[] = [];

  afterEach(async () => {
    await prisma.accessRequest.deleteMany({ where: { email: { in: createdEmails } } });
    createdEmails.length = 0;
  });

  it('creates a PENDING access request for a valid business email', async () => {
    const body = validBody();
    createdEmails.push(body.email);
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(201);

    const stored = await prisma.accessRequest.findUniqueOrThrow({ where: { email: body.email } });
    expect(stored.status).toBe('PENDING');
    expect(stored.companyName).toBe('Acme Corp');
    expect(stored.companySize).toBe('SMALL');
    expect(stored.howHeard).toBe('Saw it on LinkedIn');
  });

  it('rejects a consumer email domain', async () => {
    const body = validBody({ email: `personal-${Date.now()}@gmail.com` });
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(422);
    const stored = await prisma.accessRequest.findUnique({ where: { email: body.email } });
    expect(stored).toBeNull();
  });

  it('rejects a missing company name', async () => {
    const res = await POST(makeRequest(validBody({ companyName: '' })));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid companySize value', async () => {
    const res = await POST(makeRequest(validBody({ companySize: 'GIGANTIC' })));
    expect(res.status).toBe(400);
  });

  it('accepts a request with no howHeard (optional field)', async () => {
    const body = validBody({ howHeard: undefined });
    delete (body as { howHeard?: string }).howHeard;
    createdEmails.push(body.email);
    const res = await POST(makeRequest(body));
    expect(res.status).toBe(201);
  });

  it('resubmitting the same email while PENDING updates the existing row rather than erroring', async () => {
    const body = validBody();
    createdEmails.push(body.email);
    const first = await POST(makeRequest(body));
    expect(first.status).toBe(201);

    const second = await POST(makeRequest({ ...body, companyName: 'Acme Corp (updated)' }));
    expect(second.status).toBe(201);

    const rows = await prisma.accessRequest.findMany({ where: { email: body.email } });
    expect(rows).toHaveLength(1);
    expect(rows[0].companyName).toBe('Acme Corp (updated)');
  });

  it('resubmitting after REJECTED flips the request back to PENDING', async () => {
    const body = validBody();
    createdEmails.push(body.email);
    await POST(makeRequest(body));
    await prisma.accessRequest.update({
      where: { email: body.email },
      data: { status: 'REJECTED', reviewedAt: new Date(), reviewNote: 'not a fit' },
    });

    const res = await POST(makeRequest(body));
    expect(res.status).toBe(201);
    const stored = await prisma.accessRequest.findUniqueOrThrow({ where: { email: body.email } });
    expect(stored.status).toBe('PENDING');
    expect(stored.reviewNote).toBeNull();
  });

  it('refuses to overwrite an APPROVED request', async () => {
    const body = validBody();
    createdEmails.push(body.email);
    await POST(makeRequest(body));
    await prisma.accessRequest.update({
      where: { email: body.email },
      data: { status: 'APPROVED', reviewedAt: new Date() },
    });

    const res = await POST(makeRequest(body));
    expect(res.status).toBe(409);
    const stored = await prisma.accessRequest.findUniqueOrThrow({ where: { email: body.email } });
    expect(stored.status).toBe('APPROVED');
  });
});
