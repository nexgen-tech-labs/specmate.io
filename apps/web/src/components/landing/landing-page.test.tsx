import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LandingPage } from './landing-page';
import type { ComponentProps } from 'react';

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

let mockSearchParams = new URLSearchParams();
const routerReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: routerReplace, push: vi.fn(), refresh: vi.fn() }),
}));

function renderLandingPage(remainingInvites: number | null = 12, totalInvites = 15) {
  return render(<LandingPage remainingInvites={remainingInvites} totalInvites={totalInvites} />);
}

describe('LandingPage', () => {
  it('renders the hero headline', () => {
    renderLandingPage();
    expect(screen.getByText('Approved work items out.')).toBeDefined();
  });

  it('renders a Request access button that opens the request-access modal', () => {
    renderLandingPage();
    const buttons = screen.getAllByRole('button', { name: /request access/i });
    expect(buttons.length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/work email/i)).toBeNull();
  });

  it('shows the invite-count badge when a count is provided', () => {
    renderLandingPage(7, 15);
    expect(screen.getByText('7 of 15 invites left')).toBeDefined();
  });

  it('renders no invite-count badge when the count is null', () => {
    renderLandingPage(null, 15);
    expect(screen.queryByText(/invites left/i)).toBeNull();
  });

  it('renders the stage stepper with all five stages', () => {
    renderLandingPage();
    expect(screen.getByText('Ingest sources')).toBeDefined();
    expect(screen.getByText('AI generation')).toBeDefined();
    expect(screen.getByText('Human review')).toBeDefined();
    expect(screen.getByText('Publish to tools')).toBeDefined();
    expect(screen.getByText('Audit & sync')).toBeDefined();
  });

  it('does not render a Reset button', () => {
    renderLandingPage();
    expect(screen.queryByRole('button', { name: /^reset$/i })).toBeNull();
  });

  it('renders footer legal placeholder links', () => {
    renderLandingPage();
    expect(screen.getByText('Terms & Conditions')).toBeDefined();
    expect(screen.getByText('Privacy Policy')).toBeDefined();
  });

  it('renders the run-demo CTA', () => {
    renderLandingPage();
    expect(screen.getByRole('button', { name: /run end-to-end demo/i })).toBeDefined();
  });
});

describe('LandingPage — ?request-access deep link', () => {
  it('auto-opens the request-access modal when ?request-access=1 is present', () => {
    mockSearchParams = new URLSearchParams('request-access=1');
    renderLandingPage();
    expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
    mockSearchParams = new URLSearchParams();
  });

  it('does not auto-open the modal without the query param', () => {
    mockSearchParams = new URLSearchParams();
    renderLandingPage();
    expect(screen.queryByLabelText(/work email/i)).not.toBeInTheDocument();
  });

  it('opens the modal on a same-page navigation that adds the param post-mount (no remount)', () => {
    // Regression test: router.push('/?request-access=1') from a component
    // already mounted on "/" (e.g. the Sign In modal's "Get started" link)
    // updates useSearchParams() WITHOUT remounting LandingPage — a one-time
    // lazy useState init previously missed this entirely.
    mockSearchParams = new URLSearchParams();
    const props: ComponentProps<typeof LandingPage> = { remainingInvites: 12, totalInvites: 15 };
    const { rerender } = render(<LandingPage {...props} />);
    expect(screen.queryByLabelText(/work email/i)).not.toBeInTheDocument();

    mockSearchParams = new URLSearchParams('request-access=1');
    rerender(<LandingPage {...props} />);

    expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
    mockSearchParams = new URLSearchParams();
  });
});

describe('LandingPage — first-touch UTM attribution', () => {
  it('captures utm_* params at mount and threads them into a request-access submission', async () => {
    mockSearchParams = new URLSearchParams(
      'utm_source=twitter&utm_medium=social&utm_campaign=launch-week',
    );
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    renderLandingPage();
    fireEvent.click(screen.getAllByRole('button', { name: /request access/i })[0]);
    fireEvent.change(screen.getByLabelText(/work email/i), {
      target: { value: 'jane@acmecorp.com' },
    });
    fireEvent.change(screen.getByLabelText(/company name/i), {
      target: { value: 'Acme Corp' },
    });
    // Two "Request access →" buttons exist once the modal is open (the
    // hero's own CTA plus the modal's submit button) — the submit button is
    // the one rendered inside a <form>.
    const submitButtons = screen
      .getAllByRole('button', { name: /^request access →$/i })
      .filter((btn) => btn.closest('form'));
    fireEvent.click(submitButtons[0]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.utmSource).toBe('twitter');
    expect(body.utmMedium).toBe('social');
    expect(body.utmCampaign).toBe('launch-week');

    mockSearchParams = new URLSearchParams();
    vi.unstubAllGlobals();
  });

  it('sends null UTM fields for a visitor with no utm_* params', async () => {
    mockSearchParams = new URLSearchParams();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    renderLandingPage();
    fireEvent.click(screen.getAllByRole('button', { name: /request access/i })[0]);
    fireEvent.change(screen.getByLabelText(/work email/i), {
      target: { value: 'jane@acmecorp.com' },
    });
    fireEvent.change(screen.getByLabelText(/company name/i), {
      target: { value: 'Acme Corp' },
    });
    // Two "Request access →" buttons exist once the modal is open (the
    // hero's own CTA plus the modal's submit button) — the submit button is
    // the one rendered inside a <form>.
    const submitButtons = screen
      .getAllByRole('button', { name: /^request access →$/i })
      .filter((btn) => btn.closest('form'));
    fireEvent.click(submitButtons[0]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.utmSource).toBeNull();
    expect(body.utmMedium).toBeNull();
    expect(body.utmCampaign).toBeNull();

    vi.unstubAllGlobals();
  });
});
