import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Stepper } from './stepper';

const STEPS = [
  { key: 'a', label: 'Step A' },
  { key: 'b', label: 'Step B' },
  { key: 'c', label: 'Step C' },
];

describe('Stepper', () => {
  it('renders the compact variant by default, marking steps before current as done', () => {
    render(<Stepper steps={STEPS} currentKey="b" />);
    expect(screen.getByText('Step A')).toBeDefined();
    expect(screen.getByText('Step B')).toBeDefined();
    expect(screen.getByText('Step C')).toBeDefined();
  });

  it('renders a string meta under the label in the compact variant', () => {
    render(<Stepper steps={[{ key: 'a', label: 'Step A', meta: '3 of 5 done' }]} currentKey="a" />);
    expect(screen.getByText('3 of 5 done')).toBeDefined();
  });

  it('calls onSelect with the clicked step index', () => {
    const onSelect = vi.fn();
    render(<Stepper steps={STEPS} currentKey="a" onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Step C'));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('renders the pipeline variant with a {count, unit} meta pair and a footer', () => {
    render(
      <Stepper
        variant="pipeline"
        steps={[
          { key: 'a', label: 'Ingest sources', meta: { count: 3, unit: 'sources' } },
          { key: 'b', label: 'AI generation', meta: { count: 0, unit: 'drafted' } },
        ]}
        currentKey="a"
        footer="WORKSPACE TOTALS · LIVE"
      />,
    );
    expect(screen.getByText('3')).toBeDefined();
    expect(screen.getByText('sources')).toBeDefined();
    expect(screen.getByText('0')).toBeDefined();
    expect(screen.getByText('WORKSPACE TOTALS · LIVE')).toBeDefined();
  });

  it('omits the footer band in the pipeline variant when none is passed', () => {
    render(
      <Stepper
        variant="pipeline"
        steps={[{ key: 'a', label: 'Ingest sources', meta: { count: 1, unit: 'source' } }]}
        currentKey="a"
      />,
    );
    expect(screen.queryByText('WORKSPACE TOTALS · LIVE')).toBeNull();
  });
});
