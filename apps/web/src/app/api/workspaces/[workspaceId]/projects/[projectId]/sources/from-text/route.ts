import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireProjectRole } from '@/lib/workspace-context';
import { uploadSourceFile } from '@/lib/blob-storage';

const MAX_TEXT_LENGTH = 500_000; // ~same order as the 25MB file cap, generous for pasted notes

// Add Source's "paste a transcript" option (Onboarding Flow redesign). Kept
// structurally identical to the file-upload route above rather than a
// divergent no-blob path: writes the pasted text through the same blob
// storage call, creates a Source the same way, and triggers the same
// apps/api parse endpoint — the only difference is there's no browser File
// object, just a name + text body.
async function triggerParse(sourceId: string): Promise<void> {
  try {
    await fetch(`${process.env.API_BASE_URL}/sources/${sourceId}/parse`, { method: 'POST' });
  } catch {
    // Swallowed intentionally — Source.status (QUEUED/PARSING/PARSED/FAILED)
    // is the source of truth the UI reads later; a failed trigger just
    // leaves it at QUEUED for a manual/later retry, same as file upload.
  }
}

interface FromTextBody {
  name?: unknown;
  text?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string; projectId: string }> },
) {
  const { workspaceId, projectId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }

  const body = (await request.json().catch(() => ({}))) as FromTextBody;
  const { name, text } = body;
  if (typeof text !== 'string' || !text.trim()) {
    return NextResponse.json({ error: 'text is required.' }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `Pasted text exceeds the ${MAX_TEXT_LENGTH.toLocaleString()}-character limit.` },
      { status: 400 },
    );
  }
  const sourceName = typeof name === 'string' && name.trim() ? name.trim() : 'Pasted transcript';

  const source = await prisma.source.create({
    data: {
      projectId,
      name: sourceName,
      kind: 'TRANSCRIPT',
      status: 'QUEUED',
      scanStatus: 'CLEAN', // pasted text, not a file — nothing to scan
    },
  });

  try {
    const buffer = Buffer.from(text, 'utf-8');
    const { storageKey } = await uploadSourceFile(
      workspaceId,
      projectId,
      source.id,
      `${sourceName}.txt`,
      buffer,
      'text/plain',
    );

    const updated = await prisma.source.update({
      where: { id: source.id },
      data: { storageKey, sizeBytes: buffer.byteLength, mimeType: 'text/plain' },
    });

    await triggerParse(updated.id);

    return NextResponse.json({ source: updated }, { status: 201 });
  } catch (err) {
    await prisma.source.delete({ where: { id: source.id } });
    throw err;
  }
}
