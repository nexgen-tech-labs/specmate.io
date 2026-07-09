import { describe, expect, it } from 'vitest';
import { getStatus } from './index';

describe('connector-ado', () => {
  it('reports disconnected status as a placeholder', () => {
    expect(getStatus()).toEqual({ connected: false, provider: 'ado' });
  });
});
