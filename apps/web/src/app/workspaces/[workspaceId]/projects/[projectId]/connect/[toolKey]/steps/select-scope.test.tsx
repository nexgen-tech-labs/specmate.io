import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectScopeStep } from './select-scope';
import type { ConnectorDefinition } from '../types';

const CONNECTOR: ConnectorDefinition = {
  tool_key: 'github',
  display_name: 'GitHub',
  auth_methods: ['OAUTH'],
  scope_picker_type: 'REPO_FULL_NAME',
  capabilities: {
    supports_native_hierarchy: false,
    type_system: 'PUBLISHABLE_SET',
    parent_link_strategy: 'TASK_LIST_BACKFILL',
  },
};

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SelectScopeStep', () => {
  it('renders discovered scope options from the test-connection response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          scope_options: [
            { id: 'acme/payments', label: 'acme/payments' },
            { id: 'acme/billing', label: 'acme/billing' },
          ],
          item_types: null,
          extras: {},
        }),
      ),
    );

    render(
      <SelectScopeStep
        workspaceId="ws"
        projectId="proj"
        toolKey="github"
        wizardSessionId="wiz-1"
        connector={CONNECTOR}
        collectedState={{}}
        onAdvance={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('acme/payments')).toBeDefined());
    expect(screen.getByText('acme/billing')).toBeDefined();
  });

  it('advances to review_defaults with the chosen remote_project on Continue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          scope_options: [{ id: 'acme/payments', label: 'acme/payments' }],
          item_types: null,
          extras: {},
        }),
      ),
    );
    const onAdvance = vi.fn();

    render(
      <SelectScopeStep
        workspaceId="ws"
        projectId="proj"
        toolKey="github"
        wizardSessionId="wiz-1"
        connector={CONNECTOR}
        collectedState={{}}
        onAdvance={onAdvance}
      />,
    );

    await waitFor(() => expect(screen.getByText('acme/payments')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));

    expect(onAdvance).toHaveBeenCalledWith('review_defaults', { remote_project: 'acme/payments' });
  });

  it('shows an error when discovery fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ detail: 'Connection test failed.' }, false, 422)),
    );

    render(
      <SelectScopeStep
        workspaceId="ws"
        projectId="proj"
        toolKey="github"
        wizardSessionId="wiz-1"
        connector={CONNECTOR}
        collectedState={{}}
        onAdvance={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('Connection test failed.')).toBeDefined());
  });
});
