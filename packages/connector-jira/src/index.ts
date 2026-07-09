export interface ConnectorStatus {
  connected: boolean;
  provider: 'jira';
}

export function getStatus(): ConnectorStatus {
  return { connected: false, provider: 'jira' };
}
