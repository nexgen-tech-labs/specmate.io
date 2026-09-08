import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RequestAccessModal } from './request-access-modal';

describe('RequestAccessModal', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  function fillForm() {
    fireEvent.change(screen.getByLabelText(/work email/i), {
      target: { value: 'jane@acmecorp.com' },
    });
    fireEvent.change(screen.getByLabelText(/company name/i), {
      target: { value: 'Acme Corp' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^request access →$/i }));
  }

  it('submits the form and shows a success state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    render(<RequestAccessModal onClose={vi.fn()} />);
    fillForm();

    await waitFor(() => expect(screen.getByText('Request received')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/access-requests',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows the server error inline for a consumer-email rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'Please use your business email address.' }),
      }),
    );
    render(<RequestAccessModal onClose={vi.fn()} />);
    fillForm();

    await waitFor(() =>
      expect(screen.getByText('Please use your business email address.')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Request received')).not.toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<RequestAccessModal onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when the backdrop is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<RequestAccessModal onClose={onClose} />);
    fireEvent.click(container.firstElementChild!);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when clicking inside the modal card', () => {
    const onClose = vi.fn();
    render(<RequestAccessModal onClose={onClose} />);
    fireEvent.click(screen.getByText('Request access'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
