import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/password';

const prisma = new PrismaClient();

async function main() {
  // Idempotent: re-running against an already-seeded database is a no-op, not a crash.
  const existing = await prisma.user.findUnique({ where: { email: 'priya@acme.com' } });
  if (existing) {
    console.log('Database already seeded (priya@acme.com exists) — nothing to do.');
    return;
  }

  const workspace = await prisma.workspace.create({
    data: { name: 'Acme Corp' },
  });

  const user = await prisma.user.create({
    data: {
      email: 'priya@acme.com',
      name: 'Priya N',
      passwordHash: await hashPassword('seed-password-123'),
    },
  });

  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: 'ADMIN' },
  });

  const project = await prisma.project.create({
    data: { workspaceId: workspace.id, name: 'Payments Portal' },
  });

  const source = await prisma.source.create({
    data: {
      projectId: project.id,
      name: 'Client-Requirements-v3.docx',
      kind: 'DOCX',
      status: 'PARSED',
    },
  });

  const rawRequirement = await prisma.rawRequirement.create({
    data: {
      sourceId: source.id,
      text: 'As a customer, I can pay an invoice via saved card or bank transfer.',
      sectionPath: 'p.4',
      order: 0,
    },
  });

  const draftItem = await prisma.draftItem.create({
    data: {
      projectId: project.id,
      type: 'STORY',
      title: 'As a customer, I can pay an invoice via saved card or bank transfer',
      description: 'Customer self-service payment flow.',
      qualityScore: 88,
    },
  });

  await prisma.reviewDecision.create({
    data: {
      draftItemId: draftItem.id,
      decision: 'APPROVED',
      actorUserId: user.id,
    },
  });

  const publishedItem = await prisma.publishedItem.create({
    data: {
      draftItemId: draftItem.id,
      targetTool: 'JIRA',
      externalKey: 'PAY-141',
      externalUrl: 'https://acme.atlassian.net/browse/PAY-141',
    },
  });

  await prisma.traceLink.create({
    data: {
      sourceId: source.id,
      rawRequirementId: rawRequirement.id,
      draftItemId: draftItem.id,
      publishedItemId: publishedItem.id,
    },
  });

  await prisma.auditEvent.create({
    data: {
      workspaceId: workspace.id,
      actorUserId: user.id,
      action: 'draft_item.published',
      entityType: 'DraftItem',
      entityId: draftItem.id,
    },
  });

  console.log(
    `Seeded workspace ${workspace.id} with a full trace chain to PublishedItem ${publishedItem.id}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
