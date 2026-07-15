import { describe, expect, it } from 'vitest';
import {
  STARTER_BASE_USD,
  STARTER_INCLUDED_ITEMS,
  STARTER_OVERAGE_PER_ITEM_USD,
  estimateStarterMonthlyUsd,
} from './pricing';

describe('pricing (Issue 10.9)', () => {
  it('charges only the base price within the included allowance', () => {
    expect(estimateStarterMonthlyUsd(0)).toBe(STARTER_BASE_USD);
    expect(estimateStarterMonthlyUsd(STARTER_INCLUDED_ITEMS)).toBe(STARTER_BASE_USD);
  });

  it('charges base + overage per item beyond the included allowance', () => {
    const over = STARTER_INCLUDED_ITEMS + 10;
    expect(estimateStarterMonthlyUsd(over)).toBe(
      STARTER_BASE_USD + 10 * STARTER_OVERAGE_PER_ITEM_USD,
    );
  });

  it('never charges negative overage for a partially-used allowance', () => {
    expect(estimateStarterMonthlyUsd(STARTER_INCLUDED_ITEMS - 5)).toBe(STARTER_BASE_USD);
  });
});
