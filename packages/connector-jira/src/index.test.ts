import { describe, expect, it } from 'vitest';
import { getStatus } from './index';

describe('connector-jira', () => {
  it('reports disconnected status as a placeholder', () => {
    expect(getStatus()).toEqual({ connected: false, provider: 'jira' });
  });
});
