import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TeamList } from './team-list';

const baseTeams = [
  { id: 'team-1', name: 'Platform', memberCount: 3, projectScopeCount: 2 },
  { id: 'team-2', name: 'Design', memberCount: 1, projectScopeCount: 0 },
];

function renderTeamList(overrides: Partial<React.ComponentProps<typeof TeamList>> = {}) {
  return render(<TeamList workspaceId="ws-1" initialTeams={baseTeams} {...overrides} />);
}

describe('TeamList', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the team list with member and project-scope counts', () => {
    renderTeamList();
    expect(screen.getByText('Platform')).toBeDefined();
    expect(screen.getByText('3 members · 2 projects scoped')).toBeDefined();
    expect(screen.getByText('Design')).toBeDefined();
    expect(screen.getByText('1 member · unscoped')).toBeDefined();
  });

  it('creates a team and adds it to the list on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'team-3', name: 'Growth' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTeamList();
    fireEvent.change(screen.getByLabelText('Create team'), {
      target: { value: 'Growth' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.getByText('Growth')).toBeDefined());
    expect(screen.getByText('0 members · unscoped')).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/teams',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Growth' }),
      }),
    );
  });

  it('shows an inline error on a 409 duplicate-name failure without losing existing state', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'A team with this name already exists in the workspace.' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTeamList();
    fireEvent.change(screen.getByLabelText('Create team'), {
      target: { value: 'Platform' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(
        screen.getByText('A team with this name already exists in the workspace.'),
      ).toBeDefined(),
    );
    expect(screen.getByText('Platform')).toBeDefined();
    expect(screen.getByText('Design')).toBeDefined();
  });

  it('archives a team and removes it from the list on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTeamList();
    expect(screen.getByText('Platform')).toBeDefined();
    fireEvent.click(screen.getAllByRole('button', { name: 'Archive' })[0]);

    await waitFor(() => expect(screen.queryByText('Platform')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws-1/teams/team-1', {
      method: 'DELETE',
    });
    expect(screen.getByText('Design')).toBeDefined();
  });
});
