import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/password';
import type { OrgSize } from '@prisma/client';

const VALID_ORG_SIZES: OrgSize[] = ['SOLO', 'SMALL', 'MEDIUM', 'LARGE', 'ENTERPRISE'];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SignupBody {
  name: string;
  email: string;
  password: string;
  orgName: string;
  orgSize: OrgSize;
  workspaceName: string;
  teamEmails: string[];
}

function isValidBody(body: unknown): body is SignupBody {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.name === 'string' &&
    b.name.trim().length > 0 &&
    typeof b.email === 'string' &&
    b.email.includes('@') &&
    typeof b.password === 'string' &&
    b.password.length >= 8 &&
    typeof b.orgName === 'string' &&
    b.orgName.trim().length > 0 &&
    typeof b.orgSize === 'string' &&
    VALID_ORG_SIZES.includes(b.orgSize as OrgSize) &&
    typeof b.workspaceName === 'string' &&
    b.workspaceName.trim().length > 0 &&
    (b.teamEmails === undefined ||
      (Array.isArray(b.teamEmails) &&
        b.teamEmails.every((e) => typeof e === 'string' && e.includes('@'))))
  );
}

export async function POST(request: Request) {
  const body: unknown = await request.json();
  if (!isValidBody(body)) {
    return NextResponse.json({ error: 'Invalid signup details.' }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) {
    return NextResponse.json(
      { error: 'An account with this email already exists.' },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(body.password);

  // Full hierarchy at signup (Issue 12.10, extended by the Onboarding Flow
  // redesign): Organization → Workspace → User, with the signing-up user as
  // org OWNER + workspace ADMIN. Organization now carries its own name + size
  // as collected by the 4-step signup form, rather than defaulting to the
  // workspace's name.
  const { user, workspace } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { name: body.name, email: body.email, passwordHash },
    });
    const organization = await tx.organization.create({
      data: { name: body.orgName, size: body.orgSize },
    });
    const workspace = await tx.workspace.create({
      data: { name: body.workspaceName, organizationId: organization.id },
    });
    await tx.organizationMember.create({
      data: { organizationId: organization.id, userId: user.id, role: 'OWNER' },
    });
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: 'ADMIN' },
    });
    return { user, workspace };
  });

  // Signup-time team invites (step 4 of the redesigned flow) reuse the exact
  // same WorkspaceInvite shape as the post-signup invite route — creating an
  // invite is never gated (gate is at acceptance, see checkSeatGate in
  // /api/invites/[token]/accept), so a brand-new free/solo workspace can freely
  // send these; the *acceptance* of a 2nd+ one is what enforces billing.
  const teamEmails = [...new Set(body.teamEmails ?? [])];
  if (teamEmails.length > 0) {
    await prisma.workspaceInvite.createMany({
      data: teamEmails.map((email) => ({
        workspaceId: workspace.id,
        email,
        role: 'REVIEWER',
        token: randomUUID(),
        invitedByUserId: user.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })),
    });
  }

  // workspaceId lets the client route straight into the workspace dashboard
  // (Issue 10.10) instead of dead-ending on a static "done" screen.
  return NextResponse.json({ ok: true, workspaceId: workspace.id }, { status: 201 });
}
