import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthenticateStep } from './authenticate';
import type { ConnectorDefinition } from '../types';

let searchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
}));

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body };
}

const OAUTH_CONNECTOR: ConnectorDefinition = {
  tool_key: 'github',
  display_name: 'GitHub',
  auth_methods: ['ENV_CONFIGURED', 'OAUTH'],
  scope_picker_type: 'REPO_FULL_NAME',
  capabilities: {
    supports_native_hierarchy: false,
    type_system: 'PUBLISHABLE_SET',
    parent_link_strategy: 'TASK_LIST_BACKFILL',
  },
};

const ENV_CONNECTOR: ConnectorDefinition = {
  tool_key: 'jira',
  display_name: 'Jira',
  auth_methods: ['ENV_CONFIGURED'],
  scope_picker_type: 'PROJECT_KEY',
  capabilities: {
    supports_native_hierarchy: true,
    type_system: 'NAMED_TYPES',
    parent_link_strategy: 'NATIVE_FIELD',
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  searchParams = new URLSearchParams();
});

describe('AuthenticateStep', () => {
  it('renders a "Connect with GitHub" button when the registry lists OAUTH', async () => {
    vi.stubGlobal('fetch', vi.fn());

    render(
      <AuthenticateStep
        workspaceId="ws"
        projectId="proj"
        toolKey="github"
        wizardSessionId="wiz-1"
        connector={OAUTH_CONNECTOR}
        collectedState={{}}
        onAdvance={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /connect with github/i })).toBeDefined();
  });

  it('does not render an OAuth button for an ENV_CONFIGURED-only connector', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true, account: 'bot' })));

    render(
      <AuthenticateStep
        workspaceId="ws"
        projectId="proj"
        toolKey="jira"
        wizardSessionId="wiz-1"
        connector={ENV_CONNECTOR}
        collectedState={{}}
        onAdvance={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /connect with/i })).toBeNull();
  });

  it('auto-advances to select_scope on a successful ENV_CONFIGURED health check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true, account: 'bot' })));
    const onAdvance = vi.fn();

    render(
      <AuthenticateStep
        workspaceId="ws"
        projectId="proj"
        toolKey="jira"
        wizardSessionId="wiz-1"
        connector={ENV_CONNECTOR}
        collectedState={{}}
        onAdvance={onAdvance}
      />,
    );

    await waitFor(() => expect(onAdvance).toHaveBeenCalledWith('select_scope'));
  });

  it('shows an error and a retry button when the health check fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ ok: false, reason: 'Authentication rejected.' })),
    );
    const onAdvance = vi.fn();

    render(
      <AuthenticateStep
        workspaceId="ws"
        projectId="proj"
        toolKey="jira"
        wizardSessionId="wiz-1"
        connector={ENV_CONNECTOR}
        collectedState={{}}
        onAdvance={onAdvance}
      />,
    );

    await waitFor(() => expect(screen.getByText('Authentication rejected.')).toBeDefined());
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
    expect(onAdvance).not.toHaveBeenCalled();
  });
});
