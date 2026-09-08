import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isBusinessEmail } from '@/lib/business-email';
import type { OrgSize } from '@prisma/client';

const VALID_ORG_SIZES: OrgSize[] = ['SOLO', 'SMALL', 'MEDIUM', 'LARGE', 'ENTERPRISE'];

interface AccessRequestBody {
  email: string;
  companyName: string;
  companySize: OrgSize;
  howHeard?: string;
}

function isValidBody(body: unknown): body is AccessRequestBody {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.email === 'string' &&
    b.email.trim().length > 0 &&
    typeof b.companyName === 'string' &&
    b.companyName.trim().length > 0 &&
    b.companyName.trim().length <= 200 &&
    typeof b.companySize === 'string' &&
    VALID_ORG_SIZES.includes(b.companySize as OrgSize) &&
    (b.howHeard === undefined || (typeof b.howHeard === 'string' && b.howHeard.length <= 2000))
  );
}

// Public, unauthenticated — this is the pre-signup "request access" form on
// the landing page (invite-only beta). No email confirmation is sent (no
// email infra exists anywhere in this codebase); the founder's manual review
// on /internal/access-requests is the entire notification loop for now.
export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  if (!isValidBody(body)) {
    return NextResponse.json({ error: 'Invalid request details.' }, { status: 400 });
  }

  const email = body.email.trim().toLowerCase();
  if (!isBusinessEmail(email)) {
    return NextResponse.json(
      { error: 'Please use your business email address, not a personal/consumer email.' },
      { status: 422 },
    );
  }

  const existing = await prisma.accessRequest.findUnique({ where: { email } });
  if (existing?.status === 'APPROVED') {
    return NextResponse.json(
      { error: 'This email already has access — check for your signup link.' },
      { status: 409 },
    );
  }

  await prisma.accessRequest.upsert({
    where: { email },
    create: {
      email,
      companyName: body.companyName.trim(),
      companySize: body.companySize,
      howHeard: body.howHeard?.trim() || null,
    },
    // Resubmitting (including after a REJECTED outcome — circumstances
    // change) flips back to PENDING and refreshes the details on file.
    update: {
      companyName: body.companyName.trim(),
      companySize: body.companySize,
      howHeard: body.howHeard?.trim() || null,
      status: 'PENDING',
      reviewedAt: null,
      reviewNote: null,
    },
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
