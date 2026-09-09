import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { auth } from '@/lib/auth';
import { isInternalAdmin } from '@/lib/admin-access';
import { prisma } from '@/lib/prisma';
import { orgSizeLabel } from '@/lib/org-size';
import { ACCESS_REQUEST_CAP, getRemainingAccessRequestSlots } from '@/lib/access-requests';
import { AccessRequestRowActions } from './access-request-row-actions';

export const metadata: Metadata = {
  title: 'Access Requests — SpecMate Internal',
  description: 'Internal, staff-only review queue for the invite-only beta.',
};

// Pending first, then most-recently-submitted — matches the review workflow
// (the founder works through the queue, most-recent PENDING request first).
function sortRequests<T extends { status: string; createdAt: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.status === 'PENDING' && b.status !== 'PENDING') return -1;
    if (a.status !== 'PENDING' && b.status === 'PENDING') return 1;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

export default async function AccessRequestsPage() {
  const session = await auth();
  if (!isInternalAdmin(session?.user?.email)) {
    notFound();
  }

  const [requests, remaining, signupTokens] = await Promise.all([
    prisma.accessRequest.findMany(),
    getRemainingAccessRequestSlots(),
    prisma.signupToken.findMany({ select: { accessRequestId: true, token: true } }),
  ]);
  const sorted = sortRequests(requests);
  const signupUrlByRequestId = new Map(
    signupTokens.map((t) => [t.accessRequestId, `/signup-invite/${t.token}`]),
  );

  return (
    <div className="min-h-screen bg-paper px-6 py-12 text-ink">
      <div className="mx-auto max-w-5xl">
        <div className="mb-2 font-mono text-sm text-sub">INTERNAL · STAFF ONLY</div>
        <h1 className="text-3xl font-bold tracking-tight">Access Requests</h1>
        <p className="mt-2 text-base text-sub">
          Invite-only beta — {remaining} of {ACCESS_REQUEST_CAP} slots remaining.
        </p>

        <div className="mt-6 overflow-hidden rounded-lg border border-line bg-panel">
          <div className="grid grid-cols-[1fr_180px_120px_1fr_100px_160px] gap-3 border-b border-line bg-[#FCFBF8] px-5 py-3 font-mono text-xs text-sub">
            <span>EMAIL</span>
            <span>COMPANY</span>
            <span>SIZE</span>
            <span>HOW HEARD</span>
            <span>STATUS</span>
            <span>ACTIONS</span>
          </div>
          {sorted.length === 0 ? (
            <div className="px-5 py-6 text-base text-sub">No access requests yet.</div>
          ) : (
            sorted.map((r) => (
              <div
                key={r.id}
                className="grid grid-cols-[1fr_180px_120px_1fr_100px_160px] items-start gap-3 border-b border-line px-5 py-4 text-sm last:border-b-0"
              >
                <span className="break-all font-semibold">{r.email}</span>
                <span className="text-sub">{r.companyName}</span>
                <span className="font-mono text-xs text-sub">{orgSizeLabel(r.companySize)}</span>
                <span className="text-sub">
                  {r.howHeard || '—'}
                  {r.utmSource ? (
                    <span className="mt-1 block font-mono text-[10px] tracking-wide text-cobalt">
                      via {[r.utmSource, r.utmMedium, r.utmCampaign].filter(Boolean).join(' / ')}
                    </span>
                  ) : null}
                </span>
                <span
                  className={`font-mono text-xs font-bold ${
                    r.status === 'APPROVED'
                      ? 'text-green'
                      : r.status === 'REJECTED'
                        ? 'text-red'
                        : 'text-sub'
                  }`}
                >
                  {r.status}
                </span>
                {r.status === 'PENDING' ? (
                  <AccessRequestRowActions id={r.id} />
                ) : r.status === 'APPROVED' && signupUrlByRequestId.has(r.id) ? (
                  <div className="text-xs">
                    <p className="break-all font-mono text-sub">{signupUrlByRequestId.get(r.id)}</p>
                    <p className="mt-1 text-sub">
                      {r.reviewedAt ? new Date(r.reviewedAt).toLocaleDateString() : '—'}
                    </p>
                  </div>
                ) : (
                  <span className="text-xs text-sub">
                    {r.reviewedAt ? new Date(r.reviewedAt).toLocaleDateString() : '—'}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
