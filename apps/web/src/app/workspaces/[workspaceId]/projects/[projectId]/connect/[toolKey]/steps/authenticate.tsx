'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { StepProps } from '../types';

interface HealthResponse {
  ok?: boolean;
  reason?: string;
  status?: number;
  account?: string;
}

export function AuthenticateStep({
  workspaceId,
  projectId,
  toolKey,
  wizardSessionId,
  connector,
  onAdvance,
}: StepProps) {
  const searchParams = useSearchParams();
  const oauthSuccess = searchParams.get('oauth') === 'success';
  const isOAuth = connector.auth_methods.includes('OAUTH');
  const isEnvConfigured =
    connector.auth_methods.length === 1 && connector.auth_methods[0] === 'ENV_CONFIGURED';

  const [checking, setChecking] = useState(isEnvConfigured);
  const [error, setError] = useState<string | null>(null);

  async function checkHealth() {
    setChecking(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/projects/${projectId}/connectors/${toolKey}/health`,
      );
      const payload = (await res.json().catch(() => ({}))) as HealthResponse;
      if (res.ok && payload.ok) {
        await onAdvance('select_scope');
        return;
      }
      setError(payload.reason ?? 'Could not verify the connection — check your configuration.');
    } catch {
      setError('Could not reach the connector service — try again.');
    } finally {
      setChecking(false);
    }
  }

  // ENV_CONFIGURED tools (Jira/ADO today): probe health automatically and
  // auto-advance on success. checkHealth immediately calls setChecking(true),
  // which the set-state-in-effect rule flags — this is the documented
  // exception (https://react.dev/learn/you-might-not-need-an-effect):
  // kicking off a one-time async fetch on mount, mirroring how
  // onboarding-wizard.tsx handles the same pattern.
  useEffect(() => {
    if (isEnvConfigured) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void checkHealth();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEnvConfigured]);

  // After the OAuth callback redirects back here (?oauth=success), the
  // backend has already advanced the WizardSession's step server-side — but
  // this component was mounted fresh on the redirect, so re-check the
  // connector's health/existence isn't needed; just move the shell forward
  // locally to match what the backend already did.
  useEffect(() => {
    if (isOAuth && oauthSuccess) {
      void onAdvance('select_scope');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOAuth, oauthSuccess]);

  if (isEnvConfigured) {
    return (
      <div className="rounded-lg border border-line bg-panel p-8">
        <h2 className="text-lg font-semibold text-ink">Checking connection…</h2>
        <p className="mt-2 text-sm text-sub">
          Verifying {connector.display_name} is reachable with the configured credentials.
        </p>
        {checking ? <p className="mt-4 text-sm text-sub">Checking…</p> : null}
        {error ? (
          <div className="mt-4">
            <p className="text-sm text-red">{error}</p>
            <button
              type="button"
              onClick={() => void checkHealth()}
              className="mt-3 rounded-md bg-cobalt px-4 py-2 text-sm font-semibold text-white"
            >
              Retry
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (isOAuth) {
    return (
      <div className="rounded-lg border border-line bg-panel p-8">
        <h2 className="text-lg font-semibold text-ink">Connect with {connector.display_name}</h2>
        <p className="mt-2 text-sm text-sub">
          SpecMate needs access to a repository to publish issues. You&apos;ll be redirected to{' '}
          {connector.display_name} to authorize access, then brought back here automatically.
        </p>
        <button
          type="button"
          onClick={() => {
            window.location.href = `/api/connectors/github/oauth/start?wizard_session_id=${encodeURIComponent(
              wizardSessionId,
            )}`;
          }}
          className="mt-5 rounded-md bg-cobalt px-4 py-2 text-sm font-semibold text-white"
        >
          Connect with {connector.display_name} →
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-panel p-8">
      <p className="text-sm text-sub">
        No supported authentication method configured for {connector.display_name}.
      </p>
    </div>
  );
}
