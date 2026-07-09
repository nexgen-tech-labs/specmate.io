export interface ConnectorStatus {
  connected: boolean;
  provider: 'ado';
}

export function getStatus(): ConnectorStatus {
  return { connected: false, provider: 'ado' };
}
