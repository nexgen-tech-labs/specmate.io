import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TeamDetail } from './team-detail';

const baseMembers = [
  { userId: 'user-1', name: 'Alice', email: 'alice@example.com' },
  { userId: 'user-2', name: 'Bob', email: 'bob@example.com' },
];

const baseProjects = [
  { id: 'proj-1', name: 'Website' },
  { id: 'proj-2', name: 'Mobile App' },
];

function renderTeamDetail(overrides: Partial<React.ComponentProps<typeof TeamDetail>> = {}) {
  return render(
    <TeamDetail
      workspaceId="ws-1"
      teamId="team-1"
      allWorkspaceMembers={baseMembers}
      allProjects={baseProjects}
      initialMemberIds={['user-1']}
      initialProjectIds={['proj-1']}
      {...overrides}
    />,
  );
}

describe('TeamDetail', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders all workspace members and projects with correct initial checkbox states', () => {
    renderTeamDetail();

    const aliceCheckbox = screen.getByLabelText(/Alice/) as HTMLInputElement;
    const bobCheckbox = screen.getByLabelText(/Bob/) as HTMLInputElement;
    expect(aliceCheckbox.checked).toBe(true);
    expect(bobCheckbox.checked).toBe(false);

    const websiteCheckbox = screen.getByLabelText('Website') as HTMLInputElement;
    const mobileCheckbox = screen.getByLabelText('Mobile App') as HTMLInputElement;
    expect(websiteCheckbox.checked).toBe(true);
    expect(mobileCheckbox.checked).toBe(false);
  });

  it('sends only the changed member diff on save, not the full list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTeamDetail();
    fireEvent.click(screen.getByLabelText(/Bob/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/teams/team-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          addMemberIds: ['user-2'],
          removeMemberIds: [],
          projectIds: ['proj-1'],
        }),
      }),
    );
  });

  it('sends removeMemberIds when unchecking an initially-selected member', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTeamDetail();
    fireEvent.click(screen.getByLabelText(/Alice/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/teams/team-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          addMemberIds: [],
          removeMemberIds: ['user-1'],
          projectIds: ['proj-1'],
        }),
      }),
    );
  });

  it('sends projectIds as the full set of currently-checked projects, not a diff', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTeamDetail();
    fireEvent.click(screen.getByLabelText('Mobile App'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/teams/team-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          addMemberIds: [],
          removeMemberIds: [],
          projectIds: ['proj-1', 'proj-2'],
        }),
      }),
    );
  });

  it('sends projectIds: [] (not omitted) when unchecking all projects, to explicitly unscope the team', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTeamDetail();
    fireEvent.click(screen.getByLabelText('Website'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(requestInit.body as string) as {
      addMemberIds: string[];
      removeMemberIds: string[];
      projectIds: string[];
    };
    expect(sentBody).toHaveProperty('projectIds');
    expect(sentBody.projectIds).toEqual([]);
  });

  it('shows a 400 error message inline without crashing', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'All team members must already be members of this workspace.' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTeamDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(
        screen.getByText('All team members must already be members of this workspace.'),
      ).toBeDefined(),
    );
    // Page did not crash — members/projects are still rendered.
    expect(screen.getByLabelText(/Alice/)).toBeDefined();
  });

  it('updates the baseline after a successful save so a second no-op save sends empty diffs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderTeamDetail();
    fireEvent.click(screen.getByLabelText(/Bob/));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/workspaces/ws-1/teams/team-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          addMemberIds: [],
          removeMemberIds: [],
          projectIds: ['proj-1'],
        }),
      }),
    );
  });
});
