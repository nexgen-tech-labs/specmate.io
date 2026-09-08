import { NextResponse } from 'next/server';
import { ACCESS_REQUEST_CAP, getRemainingAccessRequestSlots } from '@/lib/access-requests';

// Public — powers the landing page's "N of 15 invites left" counter. Exposes
// only the count, not the underlying request list (that's admin-only, see
// /internal/access-requests).
export async function GET() {
  const remaining = await getRemainingAccessRequestSlots();
  return NextResponse.json({ remaining, total: ACCESS_REQUEST_CAP });
}
