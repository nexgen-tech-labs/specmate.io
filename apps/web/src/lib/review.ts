/**
 * Review decision core (Epic 4) — shared by the single-item, bulk, and resolution
 * routes so bulk actions produce exactly the same per-item audit granularity
 * (Issue 4.9). Every decision writes a ReviewDecision + AuditEvent attributed to
 * the actor; nothing is anonymous (Issue 4.4).
 */
import { prisma } from '@/lib/prisma';
import type { DraftItem, Prisma } from '@prisma/client';

export type DecisionAction = 'approve' | 'reject' | 'edit' | 'signoff' | 'reopen';

export interface EditPayload {
  title?: string;
  description?: string;
  payload?: Prisma.InputJsonValue;
}

export interface DecisionInput {
  action: DecisionAction;
  actorUserId: string;
  actorRole: 'ADMIN' | 'REVIEWER' | 'VIEWER';
  workspaceId: string;
  reason?: string;
  edits?: EditPayload;
}

export interface DecisionResult {
  ok: boolean;
  status: number;
  error?: string;
}

type Flags = { duplicate?: unknown; gap?: unknown; noTrace?: boolean } | null;

export function isPublishable(item: DraftItem, approvalStages: number): boolean {
  if (item.status !== 'APPROVED') return false;
  return approvalStages < 2 || item.signedOffByUserId !== null;
}

function fieldDiffs(
  item: DraftItem,
  edits: EditPayload,
  actorUserId: string,
): Array<Record<string, unknown>> {
  const diffs: Array<Record<string, unknown>> = [];
  const at = new Date().toISOString();
  if (edits.title !== undefined && edits.title !== item.title) {
    diffs.push({ at, actorUserId, field: 'title', before: item.title, after: edits.title });
  }
  if (edits.description !== undefined && edits.description !== item.description) {
    diffs.push({
      at,
      actorUserId,
      field: 'description',
      before: item.description,
      after: edits.description,
    });
  }
  if (edits.payload !== undefined) {
    diffs.push({ at, actorUserId, field: 'payload', before: item.payload, after: edits.payload });
  }
  return diffs;
}

export async function applyDecision(itemId: string, input: DecisionInput): Promise<DecisionResult> {
  if (input.actorRole === 'VIEWER')
    return { ok: false, status: 403, error: 'Viewers cannot review.' };

  const item = await prisma.draftItem.findFirst({
    where: { id: itemId, deletedAt: null, project: { workspaceId: input.workspaceId } },
    include: { project: { include: { workspace: true } } },
  });
  if (!item) return { ok: false, status: 404, error: 'Draft item not found.' };

  const flags = item.flags as Flags;

  switch (input.action) {
    case 'approve': {
      if (flags?.gap) {
        return {
          ok: false,
          status: 409,
          error:
            'This item has an unresolved information gap — answer the question or resolve it manually before approving.',
        };
      }
      await prisma.$transaction([
        prisma.draftItem.update({ where: { id: itemId }, data: { status: 'APPROVED' } }),
        prisma.reviewDecision.create({
          data: { draftItemId: itemId, decision: 'APPROVED', actorUserId: input.actorUserId },
        }),
        auditRow(input, itemId, 'draft_item.approved', {}),
      ]);
      return { ok: true, status: 200 };
    }

    case 'reject': {
      if (!input.reason?.trim()) {
        return { ok: false, status: 400, error: 'Rejection requires a reason.' };
      }
      await prisma.$transaction([
        prisma.draftItem.update({ where: { id: itemId }, data: { status: 'REJECTED' } }),
        prisma.reviewDecision.create({
          data: {
            draftItemId: itemId,
            decision: 'REJECTED',
            actorUserId: input.actorUserId,
            notes: input.reason,
          },
        }),
        auditRow(input, itemId, 'draft_item.rejected', { reason: input.reason }),
      ]);
      return { ok: true, status: 200 };
    }

    case 'edit': {
      if (!input.edits) return { ok: false, status: 400, error: 'Edit requires field changes.' };
      const diffs = fieldDiffs(item, input.edits, input.actorUserId);
      if (diffs.length === 0) return { ok: false, status: 400, error: 'No changes supplied.' };
      const history = Array.isArray(item.editHistory) ? [...(item.editHistory as unknown[])] : [];
      history.push(...diffs);
      await prisma.$transaction([
        prisma.draftItem.update({
          where: { id: itemId },
          data: {
            title: input.edits.title ?? item.title,
            description: input.edits.description ?? item.description,
            payload: input.edits.payload ?? (item.payload as Prisma.InputJsonValue) ?? undefined,
            status: 'EDITED',
            editHistory: history as Prisma.InputJsonValue,
          },
        }),
        prisma.reviewDecision.create({
          data: { draftItemId: itemId, decision: 'EDITED', actorUserId: input.actorUserId },
        }),
        auditRow(input, itemId, 'draft_item.edited', { fields: diffs.map((d) => d.field) }),
      ]);
      return { ok: true, status: 200 };
    }

    case 'signoff': {
      // Stage 2 of two-stage approval (Issue 4.7) — ADMIN only, enforced server-side.
      if (input.actorRole !== 'ADMIN') {
        return { ok: false, status: 403, error: 'Sign-off requires the ADMIN role.' };
      }
      if (item.project.workspace.approvalStages < 2) {
        return { ok: false, status: 400, error: 'This workspace uses single-stage approval.' };
      }
      if (item.status !== 'APPROVED') {
        return { ok: false, status: 409, error: 'Only approved items can be signed off.' };
      }
      await prisma.$transaction([
        prisma.draftItem.update({
          where: { id: itemId },
          data: { signedOffByUserId: input.actorUserId },
        }),
        auditRow(input, itemId, 'draft_item.signed_off', {}),
      ]);
      return { ok: true, status: 200 };
    }

    case 'reopen': {
      await prisma.$transaction([
        prisma.draftItem.update({
          where: { id: itemId },
          data: { status: 'PENDING', signedOffByUserId: null },
        }),
        auditRow(input, itemId, 'draft_item.reopened', {}),
      ]);
      return { ok: true, status: 200 };
    }
  }
}

function auditRow(
  input: DecisionInput,
  itemId: string,
  action: string,
  metadata: Record<string, unknown>,
) {
  return prisma.auditEvent.create({
    data: {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action,
      entityType: 'DraftItem',
      entityId: itemId,
      metadata: metadata as Prisma.InputJsonValue,
    },
  });
}

export type DuplicateResolution = 'confirm' | 'merge' | 'override';

export async function resolveDuplicate(
  itemId: string,
  resolution: DuplicateResolution,
  input: Omit<DecisionInput, 'action'>,
): Promise<DecisionResult> {
  if (input.actorRole === 'VIEWER')
    return { ok: false, status: 403, error: 'Viewers cannot review.' };
  const item = await prisma.draftItem.findFirst({
    where: { id: itemId, deletedAt: null, project: { workspaceId: input.workspaceId } },
  });
  if (!item) return { ok: false, status: 404, error: 'Draft item not found.' };
  const flags = (item.flags ?? {}) as Record<string, unknown>;
  const duplicate = flags.duplicate as { key?: string; tool?: string } | undefined;
  if (!duplicate) return { ok: false, status: 409, error: 'Item has no duplicate flag.' };

  if (resolution === 'confirm') {
    return applyDecision(itemId, {
      ...input,
      action: 'reject',
      reason: `duplicate of ${duplicate.tool} ${duplicate.key}`,
    });
  }

  if (resolution === 'merge') {
    // v1: the merge intent (fold new info into the existing item) is recorded as an
    // audit event carrying the generated content — the actual write-back to the
    // external tool belongs to the publishing epics (5-7).
    await prisma.$transaction([
      prisma.draftItem.update({ where: { id: itemId }, data: { status: 'REJECTED' } }),
      prisma.reviewDecision.create({
        data: {
          draftItemId: itemId,
          decision: 'REJECTED',
          actorUserId: input.actorUserId,
          notes: `merged into ${duplicate.tool} ${duplicate.key}`,
        },
      }),
      prisma.auditEvent.create({
        data: {
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          action: 'duplicate.merged',
          entityType: 'DraftItem',
          entityId: itemId,
          metadata: {
            target: duplicate,
            mergedContent: { title: item.title, description: item.description },
          } as Prisma.InputJsonValue,
        },
      }),
    ]);
    return { ok: true, status: 200 };
  }

  // override: reviewer judges it's not a duplicate — distinct audit action so
  // false-positive rates stay queryable (Issue 4.5 AC).
  const { duplicate: _removed, ...rest } = flags;
  await prisma.$transaction([
    prisma.draftItem.update({
      where: { id: itemId },
      data: { flags: rest as Prisma.InputJsonValue },
    }),
    prisma.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        action: 'duplicate.overridden',
        entityType: 'DraftItem',
        entityId: itemId,
        metadata: { dismissed: duplicate } as Prisma.InputJsonValue,
      },
    }),
  ]);
  return { ok: true, status: 200 };
}

export type GapResolution = 'manual' | 'regenerated';

export async function markGapResolved(
  itemId: string,
  resolution: GapResolution,
  input: Omit<DecisionInput, 'action'>,
): Promise<DecisionResult> {
  if (input.actorRole === 'VIEWER')
    return { ok: false, status: 403, error: 'Viewers cannot review.' };
  const item = await prisma.draftItem.findFirst({
    where: { id: itemId, deletedAt: null, project: { workspaceId: input.workspaceId } },
  });
  if (!item) return { ok: false, status: 404, error: 'Draft item not found.' };
  const flags = (item.flags ?? {}) as Record<string, unknown>;
  if (!flags.gap) return { ok: false, status: 409, error: 'Item has no gap flag.' };

  const { gap: _removed, ...rest } = flags;
  await prisma.$transaction([
    prisma.draftItem.update({
      where: { id: itemId },
      data: { flags: rest as Prisma.InputJsonValue },
    }),
    prisma.auditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        // Manual fixes vs AI regenerations stay distinguishable in the audit trail (4.6 AC).
        action: resolution === 'manual' ? 'gap.resolved_manually' : 'gap.regenerated',
        entityType: 'DraftItem',
        entityId: itemId,
        metadata: { resolvedGap: flags.gap } as Prisma.InputJsonValue,
      },
    }),
  ]);
  return { ok: true, status: 200 };
}
