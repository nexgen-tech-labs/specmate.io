import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PipelineStepper } from './pipeline-stepper';
import type { PipelineSummary } from '@/lib/dashboard';

const refresh = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

const EMPTY_PIPELINE: PipelineSummary = {
  activeKey: 'ingest',
  stages: [
    { key: 'ingest', label: 'Ingest sources', count: 0, unit: 'sources' },
    { key: 'generation', label: 'AI generation', count: 0, unit: 'drafted' },
    { key: 'review', label: 'Human review', count: 0, unit: 'to approve' },
    { key: 'publish', label: 'Publish to tools', count: 0, unit: 'items live' },
    { key: 'audit', label: 'Audit & sync', count: 0, unit: 'in sync' },
  ],
};

const WITH_SOURCE_PIPELINE: PipelineSummary = {
  ...EMPTY_PIPELINE,
  stages: EMPTY_PIPELINE.stages.map((s) => (s.key === 'ingest' ? { ...s, count: 1 } : s)),
};

describe('PipelineStepper generate action', () => {
  beforeEach(() => {
    refresh.mockClear();
    push.mockClear();
    vi.unstubAllGlobals();
  });

  it('does not show a Generate button when there are no sources yet', () => {
    render(
      <PipelineStepper pipeline={EMPTY_PIPELINE} workspaceId="ws-1" defaultProjectId="proj-1" />,
    );
    expect(screen.queryByRole('button', { name: /generate/i })).toBeNull();
  });

  it('does not show a Generate button for a VIEWER (no defaultProjectId)', () => {
    render(
      <PipelineStepper
        pipeline={WITH_SOURCE_PIPELINE}
        workspaceId="ws-1"
        defaultProjectId={null}
      />,
    );
    expect(screen.queryByRole('button', { name: /generate/i })).toBeNull();
  });

  it('shows a Generate button once a source exists, and triggers /generate on click', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ run_id: 'r1', stats: {} }) }),
    );
    render(
      <PipelineStepper
        pipeline={WITH_SOURCE_PIPELINE}
        workspaceId="ws-1"
        defaultProjectId="proj-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/projects/proj-1/generate',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows an error and does not refresh when generation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ detail: 'AI service down' }) }),
    );
    render(
      <PipelineStepper
        pipeline={WITH_SOURCE_PIPELINE}
        workspaceId="ws-1"
        defaultProjectId="proj-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(() => expect(screen.getByText('AI service down')).toBeDefined());
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('PipelineStepper step navigation', () => {
  beforeEach(() => {
    refresh.mockClear();
    push.mockClear();
    vi.unstubAllGlobals();
  });

  it('navigates to the sources page when the Ingest sources card is clicked', () => {
    render(
      <PipelineStepper pipeline={EMPTY_PIPELINE} workspaceId="ws-1" defaultProjectId="proj-1" />,
    );
    fireEvent.click(screen.getByText('Ingest sources'));
    expect(push).toHaveBeenCalledWith('/workspaces/ws-1/projects/proj-1/sources');
  });

  it('navigates to the review page when the Human review card is clicked', () => {
    render(
      <PipelineStepper pipeline={EMPTY_PIPELINE} workspaceId="ws-1" defaultProjectId="proj-1" />,
    );
    fireEvent.click(screen.getByText('Human review'));
    expect(push).toHaveBeenCalledWith('/workspaces/ws-1/projects/proj-1/review');
  });

  it('navigates to the review page when the Publish to tools card is clicked (no dedicated publish page)', () => {
    render(
      <PipelineStepper pipeline={EMPTY_PIPELINE} workspaceId="ws-1" defaultProjectId="proj-1" />,
    );
    fireEvent.click(screen.getByText('Publish to tools'));
    expect(push).toHaveBeenCalledWith('/workspaces/ws-1/projects/proj-1/review');
  });

  it('navigates to the audit page when the Audit & sync card is clicked', () => {
    render(
      <PipelineStepper pipeline={EMPTY_PIPELINE} workspaceId="ws-1" defaultProjectId="proj-1" />,
    );
    fireEvent.click(screen.getByText('Audit & sync'));
    expect(push).toHaveBeenCalledWith('/workspaces/ws-1/projects/proj-1/audit');
  });

  it('does not navigate for a VIEWER (no defaultProjectId)', () => {
    render(
      <PipelineStepper pipeline={EMPTY_PIPELINE} workspaceId="ws-1" defaultProjectId={null} />,
    );
    fireEvent.click(screen.getByText('Human review'));
    expect(push).not.toHaveBeenCalled();
  });
});

describe('PipelineStepper staged-generation navigation', () => {
  beforeEach(() => {
    refresh.mockClear();
    push.mockClear();
    vi.unstubAllGlobals();
  });

  it('navigates straight to review instead of re-triggering generate when a run is already pending review', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <PipelineStepper
        pipeline={WITH_SOURCE_PIPELINE}
        workspaceId="ws-1"
        defaultProjectId="proj-1"
        pendingGenerationRunId="run-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/workspaces/ws-1/projects/proj-1/review');
  });

  it('navigates to review after a fresh generate call returns EPICS_PENDING_REVIEW', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ run_id: 'run-1', stage: 'EPICS_PENDING_REVIEW', stats: {} }),
      }),
    );
    render(
      <PipelineStepper
        pipeline={WITH_SOURCE_PIPELINE}
        workspaceId="ws-1"
        defaultProjectId="proj-1"
        pendingGenerationRunId={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('/workspaces/ws-1/projects/proj-1/review'),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
