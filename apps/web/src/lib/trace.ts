/**
 * Full trace chain resolution (Issue 8.2) — the queryable lineage behind
 * "for this Jira/ADO/GitHub key, where did it come from, what AI generated it,
 * and who approved it."
 *
 * TraceLink carries sourceId / rawRequirementId / draftItemId / publishedItemId on
 * one row, so both directions resolve without recursive joins:
 * - forward:  external key → PublishedItem → DraftItem → ReviewDecisions +
 *             RawRequirements (with location pointers) → Sources
 * - reverse:  Source → every DraftItem and external key it contributed to
 *
 * Regenerated items are handled by TraceLink duplication at regeneration time
 * (Issue 3.9 carries the original links onto the new revision) plus the
 * `revisionOfId` chain on DraftItem; multi-source items simply have multiple
 * TraceLink rows.
 */
import { prisma } from '@/lib/prisma';

export interface TraceSourceRef {
  sourceId: string;
  sourceName: string;
  rawRequirementId: string;
  /** Exact location pointer in the source: heading path / p.N / sheet/r.N / timestamp. */
  sectionPath: string;
  excerpt: string;
}

export interface TraceDecision {
  decision: string;
  actorName: string | null;
  actorEmail: string | null;
  notes: string | null;
  createdAt: Date;
}

export interface TraceChain {
  externalKey: string;
  externalUrl: string;
  targetTool: string;
  publishedAt: Date;
  item: {
    id: string;
    type: string;
    title: string;
    status: string;
    promptVersion: string | null;
    generationRunId: string | null;
    /** Prior revision ids, newest first — populated when the item was regenerated. */
    revisionChain: string[];
  };
  decisions: TraceDecision[];
  sources: TraceSourceRef[];
}

/** Forward chain: external key (e.g. PAY-141, AB#5, #12) → original source locations. */
export async function traceByExternalKey(
  workspaceId: string,
  externalKey: string,
  accessibleProjectIds?: Set<string> | null,
): Promise<TraceChain[]> {
  const published = await prisma.publishedItem.findMany({
    where: {
      externalKey: { equals: externalKey.trim(), mode: 'insensitive' },
      deletedAt: null,
      draftItem: {
        project: {
          workspaceId,
          ...(accessibleProjectIds ? { id: { in: [...accessibleProjectIds] } } : {}),
        },
      },
    },
    include: {
      draftItem: {
        include: {
          reviewDecisions: {
            include: { actor: { select: { name: true, email: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      },
      traceLinks: {
        include: { rawRequirement: true, source: { select: { id: true, name: true } } },
      },
    },
  });

  return Promise.all(
    published.map(async (pub) => {
      // Regeneration history (Issue 3.9): walk revisionOfId back to the original draft.
      const revisionChain: string[] = [];
      let cursor = pub.draftItem.revisionOfId;
      while (cursor) {
        revisionChain.push(cursor);
        const prev = await prisma.draftItem.findUnique({
          where: { id: cursor },
          select: { revisionOfId: true },
        });
        cursor = prev?.revisionOfId ?? null;
      }
      return {
        externalKey: pub.externalKey,
        externalUrl: pub.externalUrl,
        targetTool: pub.targetTool,
        publishedAt: pub.createdAt,
        item: {
          id: pub.draftItem.id,
          type: pub.draftItem.type,
          title: pub.draftItem.title,
          status: pub.draftItem.status,
          promptVersion: pub.draftItem.promptVersion,
          generationRunId: pub.draftItem.generationRunId,
          revisionChain,
        },
        decisions: pub.draftItem.reviewDecisions.map((d) => ({
          decision: d.decision,
          actorName: d.actor?.name ?? null,
          actorEmail: d.actor?.email ?? null,
          notes: d.notes,
          createdAt: d.createdAt,
        })),
        sources: pub.traceLinks.map((link) => ({
          sourceId: link.source.id,
          sourceName: link.source.name,
          rawRequirementId: link.rawRequirement.id,
          sectionPath: link.rawRequirement.sectionPath,
          excerpt: link.rawRequirement.text.slice(0, 280),
        })),
      };
    }),
  );
}

export interface SourceContribution {
  draftItemId: string;
  itemType: string;
  itemTitle: string;
  itemStatus: string;
  sectionPath: string;
  externalKeys: Array<{ key: string; url: string; tool: string }>;
}

/** Reverse chain: a Source → every downstream item and external key it fed. */
export async function traceBySource(
  workspaceId: string,
  sourceId: string,
  accessibleProjectIds?: Set<string> | null,
): Promise<SourceContribution[] | null> {
  const source = await prisma.source.findFirst({
    where: {
      id: sourceId,
      project: {
        workspaceId,
        ...(accessibleProjectIds ? { id: { in: [...accessibleProjectIds] } } : {}),
      },
    },
  });
  if (!source) return null;

  const links = await prisma.traceLink.findMany({
    where: { sourceId },
    include: {
      rawRequirement: { select: { sectionPath: true } },
      draftItem: {
        select: {
          id: true,
          type: true,
          title: true,
          status: true,
          deletedAt: true,
          publishedItems: {
            where: { deletedAt: null },
            select: { externalKey: true, externalUrl: true, targetTool: true },
          },
        },
      },
    },
  });

  // One row per draft item (an item may cite several fragments of the same source);
  // superseded revisions (deletedAt set by regeneration) are excluded.
  const byItem = new Map<string, SourceContribution>();
  for (const link of links) {
    if (link.draftItem.deletedAt) continue;
    const existing = byItem.get(link.draftItem.id);
    if (existing) continue;
    byItem.set(link.draftItem.id, {
      draftItemId: link.draftItem.id,
      itemType: link.draftItem.type,
      itemTitle: link.draftItem.title,
      itemStatus: link.draftItem.status,
      sectionPath: link.rawRequirement.sectionPath,
      externalKeys: link.draftItem.publishedItems.map((p) => ({
        key: p.externalKey,
        url: p.externalUrl,
        tool: p.targetTool,
      })),
    });
  }
  return [...byItem.values()];
}

/** Item-level trace (for the "view full trace" panel, Issue 8.3): the same chain
 * as traceByExternalKey but keyed by draft item id, publish optional. */
export async function traceByItem(
  workspaceId: string,
  itemId: string,
  accessibleProjectIds?: Set<string> | null,
) {
  const item = await prisma.draftItem.findFirst({
    where: {
      id: itemId,
      project: {
        workspaceId,
        ...(accessibleProjectIds ? { id: { in: [...accessibleProjectIds] } } : {}),
      },
    },
    include: {
      reviewDecisions: {
        include: { actor: { select: { name: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      },
      publishedItems: { where: { deletedAt: null } },
      traceLinks: {
        include: { rawRequirement: true, source: { select: { id: true, name: true } } },
      },
    },
  });
  if (!item) return null;
  return {
    item: { id: item.id, type: item.type, title: item.title, status: item.status },
    published: item.publishedItems.map((p) => ({
      key: p.externalKey,
      url: p.externalUrl,
      tool: p.targetTool,
      at: p.createdAt,
    })),
    decisions: item.reviewDecisions.map((d) => ({
      decision: d.decision,
      actorName: d.actor?.name ?? null,
      actorEmail: d.actor?.email ?? null,
      notes: d.notes,
      createdAt: d.createdAt,
    })),
    sources: item.traceLinks.map((link) => ({
      sourceId: link.source.id,
      sourceName: link.source.name,
      rawRequirementId: link.rawRequirement.id,
      sectionPath: link.rawRequirement.sectionPath,
      excerpt: link.rawRequirement.text.slice(0, 280),
    })),
  };
}
