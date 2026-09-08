// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';

let currentSession: { user: { email: string } } | null = null;
vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { POST } = await import('./route');

function makeRequest(body: unknown = {}) {
  return new Request('http://localhost/api/access-requests/x/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/access-requests/[id]/reject', () => {
  const createdEmails: string[] = [];

  beforeEach(() => {
    vi.stubEnv('INTERNAL_ADMIN_EMAILS', 'admin@specmate.io');
    currentSession = { user: { email: 'admin@specmate.io' } };
  });

  afterEach(async () => {
    await prisma.accessRequest.deleteMany({ where: { email: { in: createdEmails } } });
    createdEmails.length = 0;
  });

  it('returns 404 for a non-admin session', async () => {
    currentSession = { user: { email: 'not-admin@example.com' } };
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'whatever' }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown request id', async () => {
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'does-not-exist' }) });
    expect(res.status).toBe(404);
  });

  it('rejects a PENDING request with an optional review note', async () => {
    const email = `reject-${Date.now()}@acmecorp.com`;
    createdEmails.push(email);
    const request = await prisma.accessRequest.create({
      data: { email, companyName: 'Acme', companySize: 'SMALL' },
    });

    const res = await POST(makeRequest({ reviewNote: 'not a fit for the beta' }), {
      params: Promise.resolve({ id: request.id }),
    });
    expect(res.status).toBe(200);

    const updated = await prisma.accessRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(updated.status).toBe('REJECTED');
    expect(updated.reviewedAt).not.toBeNull();
    expect(updated.reviewNote).toBe('not a fit for the beta');
  });

  it('rejects with no note when none is provided', async () => {
    const email = `reject-no-note-${Date.now()}@acmecorp.com`;
    createdEmails.push(email);
    const request = await prisma.accessRequest.create({
      data: { email, companyName: 'Acme', companySize: 'SMALL' },
    });

    const res = await POST(makeRequest({}), { params: Promise.resolve({ id: request.id }) });
    expect(res.status).toBe(200);

    const updated = await prisma.accessRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(updated.status).toBe('REJECTED');
    expect(updated.reviewNote).toBeNull();
  });

  it('does not count against the approved total (remaining-slots is APPROVED-only)', async () => {
    const email = `reject-slots-${Date.now()}@acmecorp.com`;
    createdEmails.push(email);
    const request = await prisma.accessRequest.create({
      data: { email, companyName: 'Acme', companySize: 'SMALL' },
    });

    // Global remaining-slots isn't safe to compare before/after here — other
    // test files exercise the real APPROVED count concurrently against the
    // same Postgres. Instead confirm directly that rejecting never sets
    // status to APPROVED, which is the only thing that could move the count.
    await POST(makeRequest({}), { params: Promise.resolve({ id: request.id }) });
    const updated = await prisma.accessRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(updated.status).toBe('REJECTED');
    expect(updated.status).not.toBe('APPROVED');
  });
});
