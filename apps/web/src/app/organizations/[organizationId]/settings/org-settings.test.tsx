import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { OrgSettings } from './org-settings';

const baseWorkspaces = [{ id: 'ws-1', name: 'Acme Core' }];
const baseMembers = [
  { userId: 'user-1', role: 'OWNER' as const, name: 'Ada Owner', email: 'ada@acme.test' },
  { userId: 'user-2', role: 'ADMIN' as const, name: 'Bob Admin', email: 'bob@acme.test' },
];

function renderOrgSettings(overrides: Partial<React.ComponentProps<typeof OrgSettings>> = {}) {
  return render(
    <OrgSettings
      organizationId="org-1"
      initialName="Acme Inc"
      initialSize="SMALL"
      isOwner={true}
      currentUserId="user-1"
      initialWorkspaces={baseWorkspaces}
      initialMembers={baseMembers}
      {...overrides}
    />,
  );
}

describe('OrgSettings', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders workspace list, member list, and org name/size', () => {
    renderOrgSettings();
    expect(screen.getByText('Acme Core')).toBeDefined();
    expect(screen.getByText('Ada Owner')).toBeDefined();
    expect(screen.getByText('Bob Admin')).toBeDefined();
    expect(screen.getByDisplayValue('Acme Inc')).toBeDefined();
  });

  it('hides the name/size edit form and the OWNER invite option for non-owners', () => {
    renderOrgSettings({ isOwner: false });
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.getByText(/Acme Inc/)).toBeDefined();
    const roleSelect = screen.getByLabelText('Role') as HTMLSelectElement;
    const options = within(roleSelect).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(['ADMIN']);
  });

  it('shows the OWNER invite option for owners', () => {
    renderOrgSettings({ isOwner: true });
    const roleSelect = screen.getByLabelText('Role') as HTMLSelectElement;
    const options = within(roleSelect).getAllByRole('option') as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(['ADMIN', 'OWNER']);
  });

  it('creates a workspace and adds it to the list on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'ws-2', name: 'New Workspace' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderOrgSettings();
    fireEvent.change(screen.getByLabelText('Create workspace'), {
      target: { value: 'New Workspace' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.getByText('New Workspace')).toBeDefined());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/organizations/org-1/workspaces',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'New Workspace' }),
      }),
    );
  });

  it('archives a workspace and removes it from the list on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderOrgSettings();
    expect(screen.getByText('Acme Core')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(screen.queryByText('Acme Core')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws-1', { method: 'DELETE' });
  });

  it('sends an invite and displays the resulting invite URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'invite-1', token: 'abc123' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderOrgSettings();
    fireEvent.change(screen.getByLabelText('Invite member'), {
      target: { value: 'newperson@acme.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));

    await waitFor(() => expect(screen.getByText(/abc123/)).toBeDefined());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/organizations/org-1/invites',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'newperson@acme.test', role: 'ADMIN' }),
      }),
    );
    expect(screen.getByText(/organization-invites\/abc123\/accept/)).toBeDefined();
  });

  it('offboard flow requires typed email match, then calls DELETE on confirm', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderOrgSettings();
    const offboardButtons = screen.getAllByRole('button', { name: 'Offboard' });
    // Second member row is Bob Admin
    fireEvent.click(offboardButtons[1]);

    const confirmInput = screen.getByLabelText(/Type bob@acme.test to confirm/i);
    const confirmButton = screen.getByRole('button', { name: 'Confirm offboard' });
    expect(confirmButton).toHaveProperty('disabled', true);

    fireEvent.change(confirmInput, { target: { value: 'wrong@acme.test' } });
    expect(confirmButton).toHaveProperty('disabled', true);

    fireEvent.change(confirmInput, { target: { value: 'bob@acme.test' } });
    expect(confirmButton).toHaveProperty('disabled', false);

    fireEvent.click(confirmButton);

    await waitFor(() => expect(screen.queryByText('Bob Admin')).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/organizations/org-1/members/user-2', {
      method: 'DELETE',
    });
  });

  it('shows an inline error and keeps the row on a 409 offboard failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Cannot remove the last owner of an organization.' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderOrgSettings();
    const offboardButtons = screen.getAllByRole('button', { name: 'Offboard' });
    fireEvent.click(offboardButtons[0]);

    const confirmInput = screen.getByLabelText(/Type ada@acme.test to confirm/i);
    fireEvent.change(confirmInput, { target: { value: 'ada@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm offboard' }));

    await waitFor(() =>
      expect(screen.getByText('Cannot remove the last owner of an organization.')).toBeDefined(),
    );
    expect(screen.getByText('Ada Owner')).toBeDefined();
  });
});
