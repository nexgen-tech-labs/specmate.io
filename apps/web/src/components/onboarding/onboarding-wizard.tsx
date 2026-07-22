'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { UploadZone } from '@/components/sources/upload-zone';
import { useTour } from '@/components/tour/tour-provider';

type StepKey = 'connect' | 'upload' | 'generate' | 'done';

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
  projectName,
  hasConnectedTool,
  hasSource,
  onStepChange,
  tourAdvanceSignal,
}: {
  workspaceId: string;
  projectId: string;
  projectName: string;
  hasConnectedTool: boolean;
  hasSource: boolean;
  /** Called whenever the wizard's own internal step changes, including once
   * on mount with the real starting step (which may not be 'connect' — see
   * the `step` initializer below). Lets an external listener (the tour)
   * mirror the wizard's true state instead of tracking it independently.
   * Optional and only meant for tests — normal usage wires this to the tour
   * automatically via useTour() below. */
  onStepChange?: (step: StepKey) => void;
  /** Bump this value (e.g. a counter) to make the wizard perform its own
   * real "primary action" for whatever step it's currently on — skip,
   * continue, or generate — matching what the corresponding button does.
   * Only fires on actual increments (tracked via a ref), not every render.
   * Optional and only meant for tests — normal usage wires this to the tour
   * automatically via useTour() below. */
  tourAdvanceSignal?: number;
}) {
  const router = useRouter();
  // The tour is always mounted globally (root layout), so this hook is
  // always safely callable. The sync logic below only does anything when a
  // wizard tour step is actually active (activeStepId indicates one), so
  // normal non-tour usage of this wizard is unaffected.
  const { syncWizardStep, wizardAdvanceSignal } = useTour();
  const effectiveOnStepChange = onStepChange ?? syncWizardStep;
  const effectiveTourAdvanceSignal = tourAdvanceSignal ?? wizardAdvanceSignal;
  const [connected, setConnected] = useState(hasConnectedTool);
  const [uploadedSourceId, setUploadedSourceId] = useState<string | null>(null);
  const [parseStatus, setParseStatus] = useState<string | null>(hasSource ? 'PARSED' : null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [itemCount, setItemCount] = useState<number | null>(null);
  const [step, setStep] = useState<StepKey>(connected || hasSource ? 'upload' : 'connect');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    effectiveOnStepChange?.(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

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
    const payload = (await res.json()) as { stats?: { item_count?: number } | null };
    setItemCount(payload.stats?.item_count ?? null);
    setStep('done');
  }

  const canGenerate = parseStatus === 'PARSED';

  // When the tour's "Next →" button is clicked while a wizard step is
  // active, TourProvider bumps tourAdvanceSignal instead of trying to drive
  // the wizard's UI directly. In response, the wizard performs its own real
  // primary action for whatever step it's currently on — the same logic the
  // corresponding on-screen button already calls. A ref tracks the previous
  // signal value so this only fires on actual increments, not every render.
  const prevTourAdvanceSignal = useRef(effectiveTourAdvanceSignal);
  useEffect(() => {
    if (effectiveTourAdvanceSignal === undefined) return;
    if (prevTourAdvanceSignal.current === effectiveTourAdvanceSignal) return;
    prevTourAdvanceSignal.current = effectiveTourAdvanceSignal;

    // This effect exists specifically to subscribe to an external signal
    // (the tour's "Next →" button, via tourAdvanceSignal) and react to it by
    // driving this component's own state — the documented exception to
    // "don't setState in an effect" (https://react.dev/learn/you-might-not-need-an-effect).
    if (step === 'connect') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStep('upload');
    } else if (step === 'upload') {
      if (canGenerate) {
        setStep('generate');
      }
      // else: no safe programmatic action — the user must upload themselves.
    } else if (step === 'generate') {
      void triggerGenerate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTourAdvanceSignal]);

  return (
    <div className="mt-8">
      {/* Step indicator (10.10 AC) — hidden on the terminal "done" screen, which
          is a standalone confirmation card, not part of the 3-step sequence. */}
      {step !== 'done' ? (
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
      ) : null}

      {step === 'connect' ? (
        <div data-tour="wizard-step-connect" className="rounded-lg border border-line bg-panel p-8">
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
        <div data-tour="wizard-step-upload" className="rounded-lg border border-line bg-panel p-8">
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
        <div
          data-tour="wizard-step-generate"
          className="rounded-lg border border-line bg-panel p-8 text-center"
        >
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

      {step === 'done' ? (
        <div className="mx-auto max-w-md rounded-xl border border-line bg-panel p-10 text-center">
          <div className="mx-auto mb-4.5 grid size-11 place-items-center rounded-full bg-green-soft text-xl text-green">
            ✓
          </div>
          <h2 className="text-xl font-bold text-ink">
            {itemCount ?? 0} item{itemCount === 1 ? '' : 's'} drafted
          </h2>
          <p className="mt-2.5 mb-6.5 text-sm leading-relaxed text-sub">
            Epics, stories, and tasks generated from <strong>{projectName}</strong>&apos;s source,
            quality-scored and ready for your review.
          </p>
          <button
            type="button"
            onClick={() => router.push(`/workspaces/${workspaceId}/projects/${projectId}/review`)}
            className="w-full rounded-md bg-cobalt px-5 py-3.5 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cobalt"
          >
            Go to Review →
          </button>
        </div>
      ) : null}
    </div>
  );
}
