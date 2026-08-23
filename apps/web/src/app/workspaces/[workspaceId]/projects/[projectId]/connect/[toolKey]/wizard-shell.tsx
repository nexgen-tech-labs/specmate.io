'use client';

import { useEffect, useState } from 'react';
import { Stepper } from '@/components/layout/stepper';
import type { CollectedState, ConnectorDefinition, WizardSessionData, WizardStep } from './types';
import { AuthenticateStep } from './steps/authenticate';
import { SelectScopeStep } from './steps/select-scope';
import { ReviewDefaultsStep } from './steps/review-defaults';
import { TestConnectionStep } from './steps/test-connection';
import { ConfirmStep } from './steps/confirm';

const STEP_LABELS: Array<{ key: WizardStep; label: string }> = [
  { key: 'authenticate', label: 'Authenticate' },
  { key: 'select_scope', label: 'Select scope' },
  { key: 'review_defaults', label: 'Review defaults' },
  { key: 'test_connection', label: 'Test connection' },
  { key: 'confirm', label: 'Confirm' },
];

export function WizardShell({
  workspaceId,
  projectId,
  toolKey,
}: {
  workspaceId: string;
  projectId: string;
  toolKey: string;
}) {
  const [connector, setConnector] = useState<ConnectorDefinition | null | undefined>(undefined);
  const [wizardSessionId, setWizardSessionId] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<WizardStep | null>(null);
  const [collectedState, setCollectedState] = useState<CollectedState>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      // (a) Look up this tool's registry definition — 404/error if unknown.
      const connectorsRes = await fetch(
        `/api/workspaces/${workspaceId}/projects/${projectId}/connectors`,
      );
      if (!connectorsRes.ok) {
        if (!cancelled) setLoadError('Could not load the connector registry.');
        return;
      }
      const connectorsPayload = (await connectorsRes.json()) as {
        connectors: ConnectorDefinition[];
      };
      const def = connectorsPayload.connectors.find((c) => c.tool_key === toolKey);
      if (!def) {
        if (!cancelled) setConnector(null);
        return;
      }
      if (cancelled) return;
      setConnector(def);

      // (b) Try to resume an existing session; otherwise create a fresh one.
      const resumeRes = await fetch(
        `/api/workspaces/${workspaceId}/projects/${projectId}/wizard-sessions/resume?tool_key=${encodeURIComponent(toolKey)}`,
      );

      let session: WizardSessionData;
      if (resumeRes.ok) {
        session = (await resumeRes.json()) as WizardSessionData;
      } else {
        const createRes = await fetch(
          `/api/workspaces/${workspaceId}/projects/${projectId}/wizard-sessions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool_key: toolKey }),
          },
        );
        if (!createRes.ok) {
          if (!cancelled) setLoadError('Could not start the setup wizard.');
          return;
        }
        session = (await createRes.json()) as WizardSessionData;

        // A freshly-created session always starts at "choose_tool" (the
        // backend's default) — this route already fixes the tool via the URL,
        // so there's nothing to choose. Auto-advance once, silently, to
        // "authenticate" before rendering any step UI, rather than rendering a
        // dead "choose_tool" screen the user never interacts with.
        if (session.current_step === 'choose_tool') {
          const patchRes = await fetch(`/api/wizard-sessions/${session.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ current_step: 'authenticate' }),
          });
          if (patchRes.ok) {
            session = (await patchRes.json()) as WizardSessionData;
          }
        }
      }

      if (cancelled) return;
      setWizardSessionId(session.id);
      setCurrentStep(session.current_step);
      setCollectedState(session.collected_state ?? {});
    }

    void init().catch(() => {
      if (!cancelled) setLoadError('Something went wrong loading the setup wizard.');
    });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, projectId, toolKey]);

  async function onAdvance(nextStep: WizardStep, stateUpdate?: Partial<CollectedState>) {
    if (!wizardSessionId) return;
    const mergedState = { ...collectedState, ...(stateUpdate ?? {}) };
    const res = await fetch(`/api/wizard-sessions/${wizardSessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_step: nextStep, collected_state: mergedState }),
    });
    if (!res.ok) {
      setLoadError('Could not save wizard progress — try again.');
      return;
    }
    const session = (await res.json()) as WizardSessionData;
    setCollectedState(session.collected_state ?? mergedState);
    setCurrentStep(session.current_step);
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-line bg-panel p-8">
        <h1 className="text-lg font-semibold text-ink">Connector setup</h1>
        <p className="mt-2 text-sm text-red">{loadError}</p>
      </div>
    );
  }

  if (connector === null) {
    return (
      <div className="rounded-lg border border-line bg-panel p-8">
        <h1 className="text-lg font-semibold text-ink">Unknown connector</h1>
        <p className="mt-2 text-sm text-sub">
          &quot;{toolKey}&quot; is not a recognized connector.
        </p>
      </div>
    );
  }

  // connector === undefined -> still loading; currentStep === null -> still
  // resuming/creating the session or auto-advancing past choose_tool.
  if (connector === undefined || currentStep === null || wizardSessionId === null) {
    return (
      <div className="rounded-lg border border-line bg-panel p-8">
        <p className="text-sm text-sub">Loading setup wizard…</p>
      </div>
    );
  }

  const stepProps = {
    workspaceId,
    projectId,
    toolKey,
    wizardSessionId,
    connector,
    collectedState,
    onAdvance,
  };

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight text-ink">
        Connect {connector.display_name}
      </h1>
      <p className="mt-2 text-base text-sub">
        A guided setup — authenticate, pick a scope, and confirm defaults before your first publish.
      </p>

      {currentStep !== 'choose_tool' ? (
        <div className="mt-8 mb-2">
          <Stepper steps={STEP_LABELS} currentKey={currentStep} />
        </div>
      ) : null}

      <div className="mt-6">
        {currentStep === 'authenticate' ? <AuthenticateStep {...stepProps} /> : null}
        {currentStep === 'select_scope' ? <SelectScopeStep {...stepProps} /> : null}
        {currentStep === 'review_defaults' ? <ReviewDefaultsStep {...stepProps} /> : null}
        {currentStep === 'test_connection' ? <TestConnectionStep {...stepProps} /> : null}
        {currentStep === 'confirm' ? <ConfirmStep {...stepProps} /> : null}
      </div>
    </div>
  );
}
