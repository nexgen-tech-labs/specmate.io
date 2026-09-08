// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/lib/prisma';
import { ACCESS_REQUEST_CAP } from '@/lib/access-requests';

let currentSession: { user: { email: string } } | null = null;
vi.mock('@/lib/auth', () => ({
  auth: async () => currentSession,
}));

const { POST } = await import('./route');

function makeRequest() {
  return new Request('http://localhost/api/access-requests/x/approve', { method: 'POST' });
}

describe('POST /api/access-requests/[id]/approve', () => {
  const createdEmails: string[] = [];

  beforeEach(() => {
    vi.stubEnv('INTERNAL_ADMIN_EMAILS', 'admin@specmate.io');
    currentSession = { user: { email: 'admin@specmate.io' } };
  });

  afterEach(async () => {
    await prisma.signupToken.deleteMany({ where: { email: { in: createdEmails } } });
    await prisma.accessRequest.deleteMany({ where: { email: { in: createdEmails } } });
    createdEmails.length = 0;
  });

  it('returns 404 for a non-admin session', async () => {
    currentSession = { user: { email: 'not-admin@example.com' } };
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'whatever' }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 when no session exists', async () => {
    currentSession = null;
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'whatever' }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown request id', async () => {
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'does-not-exist' }) });
    expect(res.status).toBe(404);
  });

  it('approves a PENDING request, creates a SignupToken, and returns a signup URL', async () => {
    const email = `approve-${Date.now()}@acmecorp.com`;
    createdEmails.push(email);
    const request = await prisma.accessRequest.create({
      data: { email, companyName: 'Acme', companySize: 'SMALL' },
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: request.id }) });
    expect(res.status).toBe(200);
    const body: { signupUrl: string } = await res.json();
    expect(body.signupUrl).toMatch(/^\/signup-invite\//);

    const updated = await prisma.accessRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(updated.status).toBe('APPROVED');
    expect(updated.reviewedAt).not.toBeNull();

    const token = await prisma.signupToken.findUniqueOrThrow({
      where: { accessRequestId: request.id },
    });
    expect(token.email).toBe(email);
    expect(token.usedAt).toBeNull();
  });

  it('returns 409 for an already-APPROVED request', async () => {
    const email = `approve-twice-${Date.now()}@acmecorp.com`;
    createdEmails.push(email);
    const request = await prisma.accessRequest.create({
      data: {
        email,
        companyName: 'Acme',
        companySize: 'SMALL',
        status: 'APPROVED',
        reviewedAt: new Date(),
      },
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: request.id }) });
    expect(res.status).toBe(409);
  });

  it('refuses to approve once the cap is reached', async () => {
    // Fill the cap with already-approved requests.
    const fillerEmails = Array.from(
      { length: ACCESS_REQUEST_CAP },
      (_, i) => `cap-filler-${Date.now()}-${i}@acmecorp.com`,
    );
    createdEmails.push(...fillerEmails);
    await prisma.accessRequest.createMany({
      data: fillerEmails.map((email) => ({
        email,
        companyName: 'Filler Co',
        companySize: 'SMALL' as const,
        status: 'APPROVED' as const,
        reviewedAt: new Date(),
      })),
    });

    const email = `over-cap-${Date.now()}@acmecorp.com`;
    createdEmails.push(email);
    const request = await prisma.accessRequest.create({
      data: { email, companyName: 'One More Co', companySize: 'SMALL' },
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: request.id }) });
    expect(res.status).toBe(422);

    const unchanged = await prisma.accessRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(unchanged.status).toBe('PENDING');
  });
});
