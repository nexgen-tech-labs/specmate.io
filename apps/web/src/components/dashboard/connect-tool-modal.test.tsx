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
    render(<ConnectToolModal organizationId="org-1" workspaceId="ws-1" onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Jira' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'GitHub' })).toBeDefined();
    expect(screen.getByText(/azure devops connects per-workspace/i)).toBeDefined();
  });

  it('creates an org wizard session and redirects to the OAuth start endpoint on pick', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'org-wiz-1' }) }),
    );
    render(<ConnectToolModal organizationId="org-1" workspaceId="ws-1" onClose={vi.fn()} />);

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
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByRole('combobox')).toBeDefined());
    expect(screen.queryByRole('button', { name: 'Jira' })).toBeNull();
  });

  it('confirms a scope selection by posting connectionId from scope-options, not the scope id', async () => {
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
  });
});
