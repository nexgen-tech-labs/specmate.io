import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireProjectRole } from '@/lib/workspace-context';
import { uploadSourceFile } from '@/lib/blob-storage';
import { scanFile, validateUpload } from '@/lib/upload-validation';

// Kinds apps/api has a parser for (Issues #8-11: docx, PDF, xlsx/csv, txt/transcripts).
const PARSEABLE_KINDS = new Set(['DOCX', 'PDF', 'XLSX', 'CSV', 'TXT', 'TRANSCRIPT']);

// Issue 9.1: strips common version markers so "Client-Requirements-v3.docx" and
// "Client-Requirements-v4.docx" normalize to the same base name for auto-detection.
function baseName(filename: string): string {
  const withoutExt = filename.replace(/\.[^.]+$/, '');
  return withoutExt
    .replace(/[-_ ]?\(?v(ersion)?\.?\s*\d+\)?$/i, '')
    .replace(/[-_ ]?\(\d+\)$/, '')
    .trim()
    .toLowerCase();
}

// Finds the most recent active Source in the project whose filename matches this
// upload's base name (ignoring version suffixes) — the auto-detected "previous
// version" when the uploader doesn't explicitly link one (Issue 9.1).
async function findVersionMatch(projectId: string, filename: string) {
  const target = baseName(filename);
  if (!target) return null;
  const candidates = await prisma.source.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, version: true },
  });
  return candidates.find((c) => baseName(c.name) === target) ?? null;
}

// Fire-and-forget from the caller's perspective: upload succeeding and parse succeeding
// are separate concerns. Source.status already reflects parse outcome (QUEUED/PARSING/
// PARSED/FAILED) for the UI to read later, so a failed trigger here doesn't fail the
// upload response — it just leaves the Source at QUEUED for a manual/later retry.
async function triggerParse(sourceId: string): Promise<void> {
  try {
    await fetch(`${process.env.API_BASE_URL}/sources/${sourceId}/parse`, { method: 'POST' });
  } catch {
    // Swallowed intentionally — see comment above.
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string; projectId: string }> },
) {
  const { workspaceId, projectId } = await params;

  const access = await requireProjectRole(workspaceId, projectId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) {
    return access.status === 404
      ? NextResponse.json({ error: 'Project not found.' }, { status: 404 })
      : NextResponse.json({ error: 'Forbidden' }, { status: access.status });
  }

  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId } });
  if (!project) {
    return NextResponse.json({ error: 'Project not found.' }, { status: 404 });
  }

  const sources = await prisma.source.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json({ sources });
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

  const formData = await request.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided.' }, { status: 400 });
  }

  const validation = validateUpload(file.name, file.type, file.size);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  // Issue 9.1: explicit linkage via the `previousVersionId` form field takes
  // priority; otherwise auto-detect by filename similarity. Either way this
  // creates a NEW Source row chained to the one it supersedes — the old
  // Source and its RawRequirements are never touched.
  const explicitPreviousId = formData.get('previousVersionId');
  let previous: { id: string; version: number } | null = null;
  if (typeof explicitPreviousId === 'string' && explicitPreviousId) {
    previous = await prisma.source.findFirst({
      where: { id: explicitPreviousId, projectId, deletedAt: null },
      select: { id: true, version: true },
    });
  } else {
    previous = await findVersionMatch(projectId, file.name);
  }

  const source = await prisma.source.create({
    data: {
      projectId,
      name: file.name,
      kind: validation.kind,
      status: 'QUEUED',
      scanStatus: 'PENDING',
      version: previous ? previous.version + 1 : 1,
      previousVersionId: previous?.id ?? null,
    },
  });

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const { storageKey } = await uploadSourceFile(
      workspaceId,
      projectId,
      source.id,
      file.name,
      buffer,
      file.type,
    );
    const scanStatus = await scanFile(buffer);

    const updated = await prisma.source.update({
      where: { id: source.id },
      data: { storageKey, sizeBytes: file.size, mimeType: file.type, scanStatus },
    });

    if (PARSEABLE_KINDS.has(updated.kind)) {
      await triggerParse(updated.id);
    }

    return NextResponse.json({ source: updated }, { status: 201 });
  } catch (err) {
    await prisma.source.delete({ where: { id: source.id } });
    throw err;
  }
}
