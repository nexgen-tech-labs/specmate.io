'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Source {
  id: string;
  name: string;
  kind: string;
  status: string;
  sizeBytes: number | null;
  createdAt: string;
}

const ACCEPTED_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
];
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function uploadWithProgress(
  url: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<{ ok: boolean; body: { source?: Source; error?: string } }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      try {
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, body: JSON.parse(xhr.responseText) });
      } catch {
        resolve({ ok: false, body: { error: 'Unexpected server response.' } });
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload.'));

    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
}

export function UploadZone({
  workspaceId,
  projectId,
  onUploaded,
}: {
  workspaceId: string;
  projectId: string;
  /** Called with each successfully-uploaded source, in addition to the normal
   * router.refresh() — lets a parent (e.g. the onboarding wizard) react without
   * re-fetching. Optional; existing callers are unaffected. */
  onUploaded?: (source: Source) => void;
}) {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<Source[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const startUpload = useCallback(
    async (file: File) => {
      setError(null);

      if (!ACCEPTED_TYPES.includes(file.type)) {
        setError(
          `Unsupported file type "${file.type || 'unknown'}". Supported: docx, pdf, xlsx, csv, txt.`,
        );
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(`File "${file.name}" exceeds the 25MB upload limit.`);
        return;
      }

      setProgress(0);
      try {
        const { ok, body } = await uploadWithProgress(
          `/api/workspaces/${workspaceId}/projects/${projectId}/sources`,
          file,
          setProgress,
        );
        if (!ok || !body.source) {
          setError(body.error ?? 'Upload failed.');
          setProgress(null);
          return;
        }
        setUploaded((prev) => [body.source as Source, ...prev]);
        setProgress(null);
        onUploaded?.(body.source as Source);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed.');
        setProgress(null);
      }
    },
    [workspaceId, projectId, router, onUploaded],
  );

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) void startUpload(file);
        }}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-12 text-center transition-colors ${
          dragging ? 'border-cobalt bg-panel' : 'border-line bg-paper'
        }`}
      >
        <p className="text-base font-semibold text-ink">Drag a file here, or click to browse</p>
        <p className="mt-2 text-sm text-sub">docx, pdf, xlsx, csv, txt — up to 25MB</p>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept={ACCEPTED_TYPES.join(',')}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void startUpload(file);
            e.target.value = '';
          }}
        />
      </div>

      {progress !== null ? (
        <div className="mt-4">
          <div className="h-2 w-full overflow-hidden rounded-full bg-line">
            <div className="h-full bg-cobalt transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-1 text-sm text-sub">Uploading… {progress}%</p>
        </div>
      ) : null}

      {error ? <p className="mt-4 text-sm text-red">{error}</p> : null}

      {uploaded.length > 0 ? (
        <ul className="mt-6 space-y-2">
          {uploaded.map((source) => (
            <li
              key={source.id}
              className="rounded-md border border-line bg-panel px-4 py-3 text-sm text-ink"
            >
              {source.name} <span className="text-sub">({source.kind})</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
