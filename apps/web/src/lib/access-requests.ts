import { prisma } from './prisma';

// Cap on the invite-only beta (marketing target: 15 B2B companies). Only
// APPROVED requests count against it — submitting doesn't consume a slot,
// only the founder's approval does. One-line change if the cap ever moves.
export const ACCESS_REQUEST_CAP = 15;

export async function getRemainingAccessRequestSlots(): Promise<number> {
  const approvedCount = await prisma.accessRequest.count({ where: { status: 'APPROVED' } });
  return Math.max(0, ACCESS_REQUEST_CAP - approvedCount);
}
