import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConnectToolModal } from './connect-tool-modal';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

describe('ConnectToolModal', () => {
  beforeEach(() => {
    refresh.mockClear();
    vi.unstubAllGlobals();
    // window.location.href is set during authorize kickoff — avoid jsdom's
    // "Not implemented: navigation" noise by stubbing it out per test.
    delete (window as unknown as { location?: unknown }).location;
    (window as unknown as { location: { href: string } }).location = { href: '' };
  });

  it('shows Jira and GitHub as pickable, with a note that ADO connects per-workspace', () => {
    render(
      <ConnectToolModal
        organizationId="org-1"
        workspaceId="ws-1"
        defaultProjectId="proj-1"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Jira' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'GitHub' })).toBeDefined();
    expect(screen.getByText(/azure devops connects per-workspace/i)).toBeDefined();
  });

  it('creates an org wizard session and redirects to the OAuth start endpoint on pick', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'org-wiz-1' }) }),
    );
    render(
      <ConnectToolModal
        organizationId="org-1"
        workspaceId="ws-1"
        defaultProjectId="proj-1"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Jira' }));

    await waitFor(() =>
      expect(window.location.href).toBe(
        '/api/connectors/jira/oauth/start?org_wizard_session_id=org-wiz-1',
      ),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/organizations/org-1/wizard-sessions',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ tool_key: 'jira' }) }),
    );
  });

  it('jumps straight to the scope picker when reopened after an OAuth return', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          connection_id: 'conn-1',
          scope_options: [{ id: 'PAY', label: 'Payments (PAY)' }],
        }),
      }),
    );
    render(
      <ConnectToolModal
        organizationId="org-1"
        workspaceId="ws-1"
        initialToolKey="jira"
        defaultProjectId="proj-1"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole('combobox')).toBeDefined());
    expect(screen.queryByRole('button', { name: 'Jira' })).toBeNull();
  });

  it('confirms a scope selection, posting connectionId from scope-options and creating the publish mapping', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('scope-options')) {
          return {
            ok: true,
            json: async () => ({
              connection_id: 'conn-1',
              scope_options: [{ id: 'PAY', label: 'Payments (PAY)' }],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
    render(
      <ConnectToolModal
        organizationId="org-1"
        workspaceId="ws-1"
        initialToolKey="jira"
        defaultProjectId="proj-1"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole('combobox')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(screen.getByText(/is connected for this workspace/i)).toBeDefined());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/connector-scope',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          connectionId: 'conn-1',
          scopeValue: 'PAY',
          scopeLabel: 'Payments (PAY)',
        }),
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/projects/proj-1/publish-mapping/jira',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ remote_project: 'PAY' }),
      }),
    );
    expect(screen.queryByText(/needs another look/i)).toBeNull();
  });

  it('skips creating a publish mapping when there is no default project (VIEWER)', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('scope-options')) {
        return {
          ok: true,
          json: async () => ({
            connection_id: 'conn-1',
            scope_options: [{ id: 'PAY', label: 'Payments (PAY)' }],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ConnectToolModal
        organizationId="org-1"
        workspaceId="ws-1"
        initialToolKey="jira"
        defaultProjectId={null}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole('combobox')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(screen.getByText(/is connected for this workspace/i)).toBeDefined());
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('publish-mapping'),
      expect.anything(),
    );
  });

  it('surfaces a non-blocking warning when the publish mapping fails to save', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('scope-options')) {
          return {
            ok: true,
            json: async () => ({
              connection_id: 'conn-1',
              scope_options: [{ id: 'PAY', label: 'Payments (PAY)' }],
            }),
          };
        }
        if (url.includes('publish-mapping')) {
          return { ok: false, json: async () => ({ detail: 'Jira connection is not configured' }) };
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
    render(
      <ConnectToolModal
        organizationId="org-1"
        workspaceId="ws-1"
        initialToolKey="jira"
        defaultProjectId="proj-1"
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole('combobox')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(screen.getByText(/is connected for this workspace/i)).toBeDefined());
    expect(screen.getByText('Jira connection is not configured')).toBeDefined();
  });
});
