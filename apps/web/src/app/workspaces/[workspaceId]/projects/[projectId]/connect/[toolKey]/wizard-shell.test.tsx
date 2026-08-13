import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WizardShell } from './wizard-shell';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(),
}));

const CONNECTOR_GITHUB = {
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

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WizardShell', () => {
  it('creates a fresh session (and auto-advances past choose_tool) when resume 404s', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/connectors')) {
        return Promise.resolve(jsonResponse({ connectors: [CONNECTOR_GITHUB] }));
      }
      if (url.includes('/wizard-sessions/resume')) {
        return Promise.resolve(jsonResponse({ error: 'not found' }, false, 404));
      }
      if (url.includes('/wizard-sessions') && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            id: 'ws-1',
            tool_key: 'github',
            current_step: 'choose_tool',
            collected_state: {},
            expires_at: new Date().toISOString(),
          }),
        );
      }
      if (url.includes('/api/wizard-sessions/ws-1') && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string) as { current_step: string };
        expect(body.current_step).toBe('authenticate');
        return Promise.resolve(
          jsonResponse({
            id: 'ws-1',
            tool_key: 'github',
            current_step: 'authenticate',
            collected_state: {},
            expires_at: new Date().toISOString(),
          }),
        );
      }
      if (url.includes('/health')) {
        return Promise.resolve(jsonResponse({ ok: false, reason: 'not configured' }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WizardShell workspaceId="ws" projectId="proj" toolKey="github" />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /connect with github/i })).toBeDefined(),
    );

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === 'string' &&
        url.includes('/wizard-sessions') &&
        !url.includes('resume') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(createCall).toBeDefined();
  });

  it('adopts the resumed session state when resume returns 200', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      void init;
      if (url.endsWith('/connectors')) {
        return Promise.resolve(jsonResponse({ connectors: [CONNECTOR_GITHUB] }));
      }
      if (url.includes('/wizard-sessions/resume')) {
        return Promise.resolve(
          jsonResponse({
            id: 'ws-existing',
            tool_key: 'github',
            current_step: 'select_scope',
            collected_state: {},
            expires_at: new Date().toISOString(),
          }),
        );
      }
      if (url.includes('/connectors/github/test')) {
        return Promise.resolve(jsonResponse({ scope_options: [], item_types: null, extras: {} }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WizardShell workspaceId="ws" projectId="proj" toolKey="github" />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /select scope/i })).toBeDefined(),
    );

    // No session-create POST should have happened since resume succeeded.
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === 'string' &&
        url.includes('/wizard-sessions') &&
        !url.includes('resume') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(createCall).toBeUndefined();
  });

  it('shows an unknown-connector state when the tool_key is not in the registry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/connectors')) {
          return Promise.resolve(jsonResponse({ connectors: [CONNECTOR_GITHUB] }));
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    render(<WizardShell workspaceId="ws" projectId="proj" toolKey="bitbucket" />);

    await waitFor(() => expect(screen.getByText(/Unknown connector/i)).toBeDefined());
  });
});
