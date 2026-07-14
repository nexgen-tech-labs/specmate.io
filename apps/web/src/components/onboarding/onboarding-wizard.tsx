'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { UploadZone } from '@/components/sources/upload-zone';

type StepKey = 'connect' | 'upload' | 'generate';

const STEPS: Array<{ key: StepKey; label: string }> = [
  { key: 'connect', label: 'Connect a tool' },
  { key: 'upload', label: 'Upload a source' },
  { key: 'generate', label: 'Generate' },
];

interface SourceStatus {
  id: string;
  status: string;
}

// Guided onboarding wizard (Issue 10.10). Connecting a tool is optional — the
// AC requires it be *offered*, but generation only needs an uploaded, parsed
// source, so skipping step 1 doesn't block progress (sensible-defaults AC).
export function OnboardingWizard({
  workspaceId,
  projectId,
  hasConnectedTool,
  hasSource,
}: {
  workspaceId: string;
  projectId: string;
  hasConnectedTool: boolean;
  hasSource: boolean;
}) {
  const router = useRouter();
  const [connected, setConnected] = useState(hasConnectedTool);
  const [uploadedSourceId, setUploadedSourceId] = useState<string | null>(null);
  const [parseStatus, setParseStatus] = useState<string | null>(hasSource ? 'PARSED' : null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [step, setStep] = useState<StepKey>(connected || hasSource ? 'upload' : 'connect');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll the just-uploaded source until parsing finishes (or fails) — the
  // synchronous parse endpoint (Issue #8/#9) usually completes in well under a
  // second, but polling keeps the wizard correct even if that changes.
  useEffect(() => {
    if (!uploadedSourceId || parseStatus === 'PARSED' || parseStatus === 'FAILED') return;
    pollRef.current = setInterval(() => {
      void fetch(`/api/workspaces/${workspaceId}/projects/${projectId}/sources/${uploadedSourceId}`)
        .then((res) => (res.ok ? (res.json() as Promise<SourceStatus>) : null))
        .then((source) => {
          if (source) setParseStatus(source.status);
        });
    }, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [uploadedSourceId, parseStatus, workspaceId, projectId]);

  async function triggerGenerate() {
    setGenerating(true);
    setGenerateError(null);
    const res = await fetch(`/api/workspaces/${workspaceId}/projects/${projectId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    setGenerating(false);
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      setGenerateError(payload.detail ?? payload.error ?? 'Generation failed.');
      return;
    }
    router.push(`/workspaces/${workspaceId}/projects/${projectId}/review`);
  }

  const canGenerate = parseStatus === 'PARSED';

  return (
    <div className="mt-8">
      {/* Step indicator (10.10 AC) */}
      <ol className="mb-8 flex items-center gap-2 text-xs">
        {STEPS.map((s, i) => {
          const done =
            (s.key === 'connect' && connected) ||
            (s.key === 'upload' && parseStatus !== null) ||
            (s.key === 'generate' && false);
          const active = step === s.key;
          return (
            <li key={s.key} className="flex items-center gap-2">
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full font-mono font-bold ${
                  done
                    ? 'bg-green text-white'
                    : active
                      ? 'bg-cobalt text-white'
                      : 'bg-line text-sub'
                }`}
              >
                {done ? '✓' : i + 1}
              </span>
              <span className={active ? 'font-semibold text-ink' : 'text-sub'}>{s.label}</span>
              {i < STEPS.length - 1 ? <span className="mx-1 text-sub">→</span> : null}
            </li>
          );
        })}
      </ol>

      {step === 'connect' ? (
        <div className="rounded-lg border border-line bg-panel p-8">
          <h2 className="text-lg font-semibold text-ink">Connect a tool (optional)</h2>
          <p className="mt-2 text-sm text-sub">
            Connecting Jira, Azure DevOps, or GitHub lets SpecMate detect duplicates against your
            existing backlog and suggest field mappings before you publish. You can also skip this
            and connect later from Settings.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link
              href={`/workspaces/${workspaceId}/projects/${projectId}/settings/publishing`}
              className="rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink"
            >
              Connect Jira
            </Link>
            <Link
              href={`/workspaces/${workspaceId}/projects/${projectId}/settings/publishing-ado`}
              className="rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink"
            >
              Connect Azure DevOps
            </Link>
            <Link
              href={`/workspaces/${workspaceId}/projects/${projectId}/settings/publishing-github`}
              className="rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink"
            >
              Connect GitHub
            </Link>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setStep('upload')}
              className="text-sm text-sub underline-offset-2 hover:underline"
            >
              Skip for now
            </button>
            <button
              type="button"
              onClick={() => {
                setConnected(true);
                setStep('upload');
              }}
              className="rounded-md bg-cobalt px-4 py-2 text-sm font-semibold text-white"
            >
              Continue →
            </button>
          </div>
        </div>
      ) : null}

      {step === 'upload' ? (
        <div className="rounded-lg border border-line bg-panel p-8">
          <h2 className="text-lg font-semibold text-ink">Upload a source</h2>
          <p className="mt-2 text-sm text-sub">
            A requirements doc, backlog export, or meeting transcript — docx, pdf, xlsx, csv, or
            txt. SpecMate parses it automatically once uploaded.
          </p>
          <div className="mt-5">
            <UploadZone
              workspaceId={workspaceId}
              projectId={projectId}
              onUploaded={(source) => {
                setUploadedSourceId(source.id);
                setParseStatus(source.status);
              }}
            />
          </div>
          {uploadedSourceId && parseStatus && parseStatus !== 'PARSED' ? (
            <p className="mt-4 text-sm text-sub">
              {parseStatus === 'FAILED' ? (
                <span className="text-red">
                  Parsing failed — check the file and try uploading again.
                </span>
              ) : (
                'Parsing…'
              )}
            </p>
          ) : null}
          <div className="mt-6 flex justify-between">
            <button
              type="button"
              onClick={() => setStep('connect')}
              className="text-sm text-sub underline-offset-2 hover:underline"
            >
              ← Back
            </button>
            <button
              type="button"
              disabled={!canGenerate}
              onClick={() => setStep('generate')}
              className="rounded-md bg-cobalt px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Continue →
            </button>
          </div>
        </div>
      ) : null}

      {step === 'generate' ? (
        <div className="rounded-lg border border-line bg-panel p-8 text-center">
          <h2 className="text-lg font-semibold text-ink">Ready to generate</h2>
          <p className="mt-2 text-sm text-sub">
            SpecMate will read your source and draft epics, stories, tasks, and acceptance criteria
            for review.
          </p>
          <button
            type="button"
            disabled={generating}
            onClick={() => void triggerGenerate()}
            className="mt-5 rounded-md bg-cobalt px-6 py-3 text-base font-semibold text-white disabled:opacity-50"
          >
            {generating ? 'Generating…' : 'Generate items →'}
          </button>
          {generateError ? <p className="mt-3 text-sm text-red">{generateError}</p> : null}
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setStep('upload')}
              className="text-sm text-sub underline-offset-2 hover:underline"
            >
              ← Back
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
