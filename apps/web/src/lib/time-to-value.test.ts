// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './prisma';
import { getTimeToValueRows, getTimeToValueSummary } from './time-to-value';

describe('time to value (Issue 10.10)', () => {
  let fast: { id: string };
  let slow: { id: string };
  let notYet: { id: string };

  beforeAll(async () => {
    const created = new Date('2026-01-01T00:00:00Z');
    fast = await prisma.workspace.create({
      data: {
        name: 'TTV Fast WS',
        createdAt: created,
        firstGenerationAt: new Date('2026-01-01T00:10:00Z'), // 10 min
      },
    });
    slow = await prisma.workspace.create({
      data: {
        name: 'TTV Slow WS',
        createdAt: created,
        firstGenerationAt: new Date('2026-01-01T01:00:00Z'), // 60 min
      },
    });
    notYet = await prisma.workspace.create({
      data: { name: 'TTV Not Yet WS', createdAt: created },
    });
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({
      where: { id: { in: [fast.id, slow.id, notYet.id] } },
    });
  });

  it('computes minutes-to-value and target status per workspace', async () => {
    const rows = await getTimeToValueRows(500);
    const byId = new Map(rows.map((r) => [r.workspaceId, r]));

    expect(byId.get(fast.id)?.minutesToValue).toBe(10);
    expect(byId.get(fast.id)?.metTarget).toBe(true);

    expect(byId.get(slow.id)?.minutesToValue).toBe(60);
    expect(byId.get(slow.id)?.metTarget).toBe(false);

    expect(byId.get(notYet.id)?.minutesToValue).toBeNull();
    expect(byId.get(notYet.id)?.metTarget).toBeNull();
  });

  it('summary target is the 15-minute threshold and includes this workspace pair', async () => {
    // getTimeToValueSummary aggregates across all workspaces, so this only asserts
    // the fixed target and that our two known-value workspaces are counted somewhere
    // in the total — not exact reached/median, which would be shared-state-fragile.
    const summary = await getTimeToValueSummary();
    expect(summary.target).toBe(15);
    expect(summary.total).toBeGreaterThanOrEqual(2);
  });
});
