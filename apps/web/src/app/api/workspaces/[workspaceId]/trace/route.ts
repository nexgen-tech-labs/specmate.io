import { NextResponse } from 'next/server';
import { getAccessibleProjectIds, requireWorkspaceRole } from '@/lib/workspace-context';
import { traceByExternalKey, traceByItem, traceBySource } from '@/lib/trace';

type Params = { params: Promise<{ workspaceId: string }> };

// Trace chain lookup (Issue 8.2), three modes:
//   ?key=PAY-141   → forward chain from an external key
//   ?item=<id>     → full trace for one draft item (Issue 8.3's trace panel)
//   ?source=<id>   → reverse chain: everything a source contributed to
// Read-only — VIEWERs included (Delivery Managers checking history).
// Team-scoped members (Issue 12.11) only resolve traces within their scoped
// projects — workspace-wide search must not leak out-of-scope items.
export async function GET(request: Request, { params }: Params) {
  const { workspaceId } = await params;

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }
  const accessibleIds = await getAccessibleProjectIds(workspaceId, access.membership);

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const item = url.searchParams.get('item');
  const source = url.searchParams.get('source');

  if (key) {
    const chains = await traceByExternalKey(workspaceId, key, accessibleIds);
    return NextResponse.json({ mode: 'key', chains });
  }
  if (item) {
    const trace = await traceByItem(workspaceId, item, accessibleIds);
    if (!trace) return NextResponse.json({ error: 'Item not found.' }, { status: 404 });
    return NextResponse.json({ mode: 'item', trace });
  }
  if (source) {
    const contributions = await traceBySource(workspaceId, source, accessibleIds);
    if (contributions === null)
      return NextResponse.json({ error: 'Source not found.' }, { status: 404 });
    return NextResponse.json({ mode: 'source', contributions });
  }
  return NextResponse.json(
    { error: 'Provide one of ?key=, ?item=, or ?source=.' },
    { status: 400 },
  );
}
