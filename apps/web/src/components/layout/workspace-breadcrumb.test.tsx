import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceBreadcrumb } from './workspace-breadcrumb';

let mockPathname = '/workspaces/ws-1';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

describe('WorkspaceBreadcrumb', () => {
  it('renders nothing on the workspace dashboard itself', () => {
    mockPathname = '/workspaces/ws-1';
    render(<WorkspaceBreadcrumb workspaceId="ws-1" />);
    expect(screen.queryByText(/back to dashboard/i)).not.toBeInTheDocument();
  });

  it('renders a link back to the dashboard on a nested workspace page', () => {
    mockPathname = '/workspaces/ws-1/teams/team-1';
    render(<WorkspaceBreadcrumb workspaceId="ws-1" />);
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toHaveAttribute(
      'href',
      '/workspaces/ws-1',
    );
  });

  it('renders on the settings/teams list page too', () => {
    mockPathname = '/workspaces/ws-1/settings';
    render(<WorkspaceBreadcrumb workspaceId="ws-1" />);
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toBeInTheDocument();
  });

  it("does not confuse a different workspace's dashboard path with this one", () => {
    mockPathname = '/workspaces/ws-2';
    render(<WorkspaceBreadcrumb workspaceId="ws-1" />);
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toHaveAttribute(
      'href',
      '/workspaces/ws-1',
    );
  });
});
