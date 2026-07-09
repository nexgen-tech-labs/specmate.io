import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, scanFile, validateUpload } from './upload-validation';

describe('validateUpload', () => {
  it('maps allowed mime types to the correct SourceKind', () => {
    expect(
      validateUpload(
        'a.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        100,
      ),
    ).toEqual({
      ok: true,
      kind: 'DOCX',
    });
    expect(validateUpload('a.pdf', 'application/pdf', 100)).toEqual({ ok: true, kind: 'PDF' });
    expect(
      validateUpload(
        'a.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        100,
      ),
    ).toEqual({ ok: true, kind: 'XLSX' });
    expect(validateUpload('a.csv', 'text/csv', 100)).toEqual({ ok: true, kind: 'CSV' });
    expect(validateUpload('a.txt', 'text/plain', 100)).toEqual({ ok: true, kind: 'TXT' });
  });

  it('rejects an unsupported mime type', () => {
    const result = validateUpload('a.exe', 'application/x-msdownload', 100);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Unsupported file type');
  });

  it('rejects a file exactly over the size limit', () => {
    const result = validateUpload('a.pdf', 'application/pdf', MAX_UPLOAD_BYTES + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('exceeds');
  });

  it('accepts a file exactly at the size limit', () => {
    const result = validateUpload('a.pdf', 'application/pdf', MAX_UPLOAD_BYTES);
    expect(result.ok).toBe(true);
  });
});

describe('scanFile', () => {
  it('always resolves CLEAN (stub, no real AV integration yet)', async () => {
    await expect(scanFile(Buffer.from('anything'))).resolves.toBe('CLEAN');
  });
});
