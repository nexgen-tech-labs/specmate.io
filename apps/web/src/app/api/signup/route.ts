import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/password';

interface SignupBody {
  name: string;
  email: string;
  password: string;
  workspaceName: string;
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
    typeof b.workspaceName === 'string' &&
    b.workspaceName.trim().length > 0
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

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { name: body.name, email: body.email, passwordHash },
    });
    const workspace = await tx.workspace.create({
      data: { name: body.workspaceName },
    });
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: user.id, role: 'ADMIN' },
    });
    return { user, workspace };
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
