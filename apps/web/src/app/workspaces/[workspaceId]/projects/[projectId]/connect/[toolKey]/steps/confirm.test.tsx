import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmStep } from './confirm';
import type { ConnectorDefinition } from '../types';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

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
  push.mockClear();
});

describe('ConfirmStep', () => {
  it('POSTs to the mapping-save endpoint with the correct body shape on submit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ remote_project: 'acme/payments', format_mode: 'HUMAN', metadata: {} }),
      );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ConfirmStep
        workspaceId="ws"
        projectId="proj"
        toolKey="github"
        wizardSessionId="wiz-1"
        connector={CONNECTOR}
        collectedState={{ remote_project: 'acme/payments' }}
        onAdvance={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save & finish/i }));

    await waitFor(() => expect(push).toHaveBeenCalled());

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws/projects/proj/publish-mapping/github',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote_project: 'acme/payments', format_mode: 'HUMAN' }),
      }),
    );
    expect(push).toHaveBeenCalledWith('/workspaces/ws/projects/proj/settings/publishing-github');
  });

  it('shows an error message when saving fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ detail: 'Repository not found.' }, false, 422)),
    );

    render(
      <ConfirmStep
        workspaceId="ws"
        projectId="proj"
        toolKey="github"
        wizardSessionId="wiz-1"
        connector={CONNECTOR}
        collectedState={{ remote_project: 'acme/payments' }}
        onAdvance={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save & finish/i }));

    await waitFor(() => expect(screen.getByText('Repository not found.')).toBeDefined());
    expect(push).not.toHaveBeenCalled();
  });
});
