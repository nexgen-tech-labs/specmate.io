// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { applyDecision, isPublishable, markGapResolved, resolveDuplicate } from './review';

describe('review decisions (Epic 4)', () => {
  let workspaceId: string;
  let projectId: string;
  let adminId: string;
  let reviewerId: string;

  async function makeItem(overrides: object = {}) {
    return prisma.draftItem.create({
      data: {
        projectId,
        type: 'STORY',
        title: 'As a customer, I can pay an invoice',
        description: 'Payment flow story.',
        originalDraft: {
          title: 'As a customer, I can pay an invoice',
          description: 'Payment flow story.',
        },
        ...overrides,
      },
    });
  }

  beforeAll(async () => {
    const ws = await prisma.workspace.create({
      data: { name: 'Review Test WS', approvalStages: 2 },
    });
    workspaceId = ws.id;
    const project = await prisma.project.create({ data: { workspaceId, name: 'Review Project' } });
    projectId = project.id;
    const admin = await prisma.user.create({
      data: { email: `rev-admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x' },
    });
    adminId = admin.id;
    const reviewer = await prisma.user.create({
      data: { email: `rev-rev-${Date.now()}@test.local`, name: 'Rev', passwordHash: 'x' },
    });
    reviewerId = reviewer.id;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: adminId, role: 'ADMIN' },
        { workspaceId, userId: reviewerId, role: 'REVIEWER' },
      ],
    });
  });

  afterAll(async () => {
    // AuditEvent is trigger-protected (append-only, Issue 8.1); test-database cleanup
    // is the one sanctioned use of the maintenance GUC, and it must share the trigger's
    // session — hence a single transaction.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL specmate.maintenance = 'on'`),
      prisma.auditEvent.deleteMany({ where: { workspaceId } }),
    ]);
    await prisma.reviewDecision.deleteMany({ where: { draftItem: { projectId } } });
    await prisma.draftItem.deleteMany({ where: { projectId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, reviewerId] } } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  });

  // Functions, not consts: workspaceId is assigned in beforeAll, after describe-body
  // evaluation — capturing it eagerly would freeze `undefined` into every call.
  const asReviewer = () => ({ actorRole: 'REVIEWER' as const, workspaceId });
  const asAdmin = () => ({ actorRole: 'ADMIN' as const, workspaceId });

  it('approve records an attributed ReviewDecision and AuditEvent', async () => {
    const item = await makeItem();
    const result = await applyDecision(item.id, {
      ...asReviewer(),
      actorUserId: reviewerId,
      action: 'approve',
    });
    expect(result.ok).toBe(true);

    const decision = await prisma.reviewDecision.findFirst({ where: { draftItemId: item.id } });
    expect(decision?.decision).toBe('APPROVED');
    expect(decision?.actorUserId).toBe(reviewerId);
    const audit = await prisma.auditEvent.findFirst({
      where: { entityId: item.id, action: 'draft_item.approved' },
    });
    expect(audit?.actorUserId).toBe(reviewerId);
  });

  it('reject without a reason is refused', async () => {
    const item = await makeItem();
    const result = await applyDecision(item.id, {
      ...asReviewer(),
      actorUserId: reviewerId,
      action: 'reject',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it('gap-flagged items cannot be approved until resolved (4.6 guard)', async () => {
    const item = await makeItem({ flags: { gap: { question: 'Which ERP version?' } } });
    const blocked = await applyDecision(item.id, {
      ...asReviewer(),
      actorUserId: reviewerId,
      action: 'approve',
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe(409);

    const resolved = await markGapResolved(item.id, 'manual', {
      ...asReviewer(),
      actorUserId: reviewerId,
    });
    expect(resolved.ok).toBe(true);
    const audit = await prisma.auditEvent.findFirst({
      where: { entityId: item.id, action: 'gap.resolved_manually' },
    });
    expect(audit).not.toBeNull();

    const approved = await applyDecision(item.id, {
      ...asReviewer(),
      actorUserId: reviewerId,
      action: 'approve',
    });
    expect(approved.ok).toBe(true);
  });

  it('edit tracks structured field diffs and never loses the original draft (4.3)', async () => {
    const item = await makeItem();
    const first = await applyDecision(item.id, {
      ...asReviewer(),
      actorUserId: reviewerId,
      action: 'edit',
      edits: { title: 'As a customer, I can pay an invoice with a saved card' },
    });
    expect(first.ok).toBe(true);
    const second = await applyDecision(item.id, {
      ...asReviewer(),
      actorUserId: reviewerId,
      action: 'edit',
      edits: { description: 'Saved-card payment flow, PCI-DSS scoped.' },
    });
    expect(second.ok).toBe(true);

    const updated = await prisma.draftItem.findUnique({ where: { id: item.id } });
    const history = updated?.editHistory as Array<{ field: string; before: string; after: string }>;
    expect(history).toHaveLength(2); // sequence, not first-vs-last
    expect(history[0].field).toBe('title');
    expect(history[1].field).toBe('description');
    expect((updated?.originalDraft as { title: string }).title).toBe(
      'As a customer, I can pay an invoice',
    );
    expect(updated?.status).toBe('EDITED');
  });

  it('two-stage approval: publishable only after ADMIN sign-off, stage skip rejected (4.7)', async () => {
    const item = await makeItem();
    // Sign-off before approval is rejected (server-side state machine).
    const premature = await applyDecision(item.id, {
      ...asAdmin(),
      actorUserId: adminId,
      action: 'signoff',
    });
    expect(premature.ok).toBe(false);
    expect(premature.status).toBe(409);

    await applyDecision(item.id, { ...asReviewer(), actorUserId: reviewerId, action: 'approve' });
    let row = await prisma.draftItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(isPublishable(row, 2)).toBe(false); // approved but not signed off

    // REVIEWER cannot perform the sign-off stage.
    const wrongRole = await applyDecision(item.id, {
      ...asReviewer(),
      actorUserId: reviewerId,
      action: 'signoff',
    });
    expect(wrongRole.status).toBe(403);

    const signoff = await applyDecision(item.id, {
      ...asAdmin(),
      actorUserId: adminId,
      action: 'signoff',
    });
    expect(signoff.ok).toBe(true);
    row = await prisma.draftItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(isPublishable(row, 2)).toBe(true);
    expect(isPublishable({ ...row, signedOffByUserId: null }, 1)).toBe(true); // single-stage mode
  });

  it('duplicate resolutions: confirm rejects with linked reason, override clears flag with distinct audit (4.5)', async () => {
    const flagged = { flags: { duplicate: { key: 'PAY-118', tool: 'JIRA', confidence: 0.82 } } };
    const confirmItem = await makeItem(flagged);
    const confirmed = await resolveDuplicate(confirmItem.id, 'confirm', {
      ...asReviewer(),
      actorUserId: reviewerId,
    });
    expect(confirmed.ok).toBe(true);
    const rejected = await prisma.draftItem.findUnique({ where: { id: confirmItem.id } });
    expect(rejected?.status).toBe('REJECTED');
    const decision = await prisma.reviewDecision.findFirst({
      where: { draftItemId: confirmItem.id },
    });
    expect(decision?.notes).toContain('PAY-118');

    const overrideItem = await makeItem(flagged);
    const overridden = await resolveDuplicate(overrideItem.id, 'override', {
      ...asReviewer(),
      actorUserId: reviewerId,
    });
    expect(overridden.ok).toBe(true);
    const cleared = await prisma.draftItem.findUnique({ where: { id: overrideItem.id } });
    expect((cleared?.flags as { duplicate?: unknown })?.duplicate).toBeUndefined();
    // Overrides queryable separately for false-positive monitoring.
    const overrideAudits = await prisma.auditEvent.findMany({
      where: { workspaceId, action: 'duplicate.overridden' },
    });
    expect(overrideAudits.length).toBe(1);

    const mergeItem = await makeItem(flagged);
    const merged = await resolveDuplicate(mergeItem.id, 'merge', {
      ...asReviewer(),
      actorUserId: reviewerId,
    });
    expect(merged.ok).toBe(true);
    const mergeAudit = await prisma.auditEvent.findFirst({
      where: { entityId: mergeItem.id, action: 'duplicate.merged' },
    });
    expect(mergeAudit).not.toBeNull();
  });

  it('viewers cannot make decisions', async () => {
    const item = await makeItem();
    const result = await applyDecision(item.id, {
      action: 'approve',
      actorUserId: reviewerId,
      actorRole: 'VIEWER',
      workspaceId,
    });
    expect(result.status).toBe(403);
  });

  it('approved items are locked against regeneration paths but can be reopened', async () => {
    const item = await makeItem();
    await applyDecision(item.id, { ...asReviewer(), actorUserId: reviewerId, action: 'approve' });
    const reopened = await applyDecision(item.id, {
      ...asReviewer(),
      actorUserId: reviewerId,
      action: 'reopen',
    });
    expect(reopened.ok).toBe(true);
    const row = await prisma.draftItem.findUnique({ where: { id: item.id } });
    expect(row?.status).toBe('PENDING');
  });
});
