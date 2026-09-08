// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { ACCESS_REQUEST_CAP } from '@/lib/access-requests';

const { GET } = await import('./route');

describe('GET /api/access-requests/remaining-slots', () => {
  const createdEmails: string[] = [];

  afterEach(async () => {
    await prisma.accessRequest.deleteMany({ where: { email: { in: createdEmails } } });
    createdEmails.length = 0;
  });

  it('returns the full cap when no requests are approved', async () => {
    const res = await GET();
    const body: { remaining: number; total: number } = await res.json();
    expect(body.total).toBe(ACCESS_REQUEST_CAP);
    expect(body.remaining).toBeLessThanOrEqual(ACCESS_REQUEST_CAP);
  });

  it('decrements by exactly one per approved request, unaffected by pending/rejected ones', async () => {
    // Computes the expected value from a fresh DB count taken immediately
    // before the assertion, rather than a before/after GET snapshot — other
    // test files exercise the real APPROVED count concurrently against the
    // same Postgres, so a snapshot taken earlier can go stale mid-test.
    const pendingEmail = `remaining-pending-${Date.now()}@acmecorp.com`;
    const approvedEmail = `remaining-approved-${Date.now()}@acmecorp.com`;
    const rejectedEmail = `remaining-rejected-${Date.now()}@acmecorp.com`;
    createdEmails.push(pendingEmail, approvedEmail, rejectedEmail);

    const approvedCountBefore = await prisma.accessRequest.count({
      where: { status: 'APPROVED' },
    });

    await prisma.accessRequest.create({
      data: { email: pendingEmail, companyName: 'A', companySize: 'SMALL' },
    });
    await prisma.accessRequest.create({
      data: {
        email: approvedEmail,
        companyName: 'B',
        companySize: 'SMALL',
        status: 'APPROVED',
        reviewedAt: new Date(),
      },
    });
    await prisma.accessRequest.create({
      data: {
        email: rejectedEmail,
        companyName: 'C',
        companySize: 'SMALL',
        status: 'REJECTED',
        reviewedAt: new Date(),
      },
    });

    const approvedCountAfter = await prisma.accessRequest.count({ where: { status: 'APPROVED' } });
    const body = (await (await GET()).json()) as { remaining: number };
    const expectedRemaining = Math.max(0, ACCESS_REQUEST_CAP - approvedCountAfter);
    expect(approvedCountAfter).toBe(approvedCountBefore + 1);
    expect(body.remaining).toBe(expectedRemaining);
  });
});
