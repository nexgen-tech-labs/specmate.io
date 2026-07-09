import type { ScanStatus, SourceKind } from '@prisma/client';

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? '25') * 1024 * 1024;

const MIME_TO_SOURCE_KIND: Record<string, SourceKind> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'text/csv': 'CSV',
  'text/plain': 'TXT',
};

export interface UploadValidationError {
  ok: false;
  error: string;
}

export interface UploadValidationOk {
  ok: true;
  kind: SourceKind;
}

export function validateUpload(
  fileName: string,
  mimeType: string,
  sizeBytes: number,
): UploadValidationOk | UploadValidationError {
  const kind = MIME_TO_SOURCE_KIND[mimeType];
  if (!kind) {
    return {
      ok: false,
      error: `Unsupported file type "${mimeType || 'unknown'}". Supported types: docx, pdf, xlsx, csv, txt.`,
    };
  }

  if (sizeBytes > MAX_UPLOAD_BYTES) {
    const maxMb = MAX_UPLOAD_BYTES / (1024 * 1024);
    return { ok: false, error: `File "${fileName}" exceeds the ${maxMb}MB upload limit.` };
  }

  return { ok: true, kind };
}

// Placeholder — no real antivirus integration is wired up yet (see architecture.md).
// Always resolves CLEAN so the upload pipeline has a scan step to slot a real scanner
// (e.g. a ClamAV sidecar, or an Azure-native scanning offering) into later without a
// schema or API shape change.
export async function scanFile(_file: Buffer): Promise<ScanStatus> {
  return 'CLEAN';
}
