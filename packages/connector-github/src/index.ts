export interface ConnectorStatus {
  connected: boolean;
  provider: 'github';
}

export function getStatus(): ConnectorStatus {
  return { connected: false, provider: 'github' };
}
