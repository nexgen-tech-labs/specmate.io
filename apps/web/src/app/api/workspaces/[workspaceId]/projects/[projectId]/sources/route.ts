import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireWorkspaceRole } from '@/lib/workspace-context';
import { uploadSourceFile } from '@/lib/blob-storage';
import { scanFile, validateUpload } from '@/lib/upload-validation';

// Kinds apps/api has a parser for (Issues #8-11: docx, PDF, xlsx/csv, txt/transcripts).
const PARSEABLE_KINDS = new Set(['DOCX', 'PDF', 'XLSX', 'CSV', 'TXT', 'TRANSCRIPT']);

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

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER', 'VIEWER']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
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

  const access = await requireWorkspaceRole(workspaceId, ['ADMIN', 'REVIEWER']);
  if (!access.ok) {
    return NextResponse.json({ error: 'Forbidden' }, { status: access.status });
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

  const source = await prisma.source.create({
    data: {
      projectId,
      name: file.name,
      kind: validation.kind,
      status: 'QUEUED',
      scanStatus: 'PENDING',
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
