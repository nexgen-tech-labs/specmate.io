// Shared types for the connector setup wizard (Issue #101, Task 9).

export type WizardStep =
  | 'choose_tool'
  | 'authenticate'
  | 'select_scope'
  | 'review_defaults'
  | 'test_connection'
  | 'confirm';

export interface ConnectorCapabilities {
  supports_native_hierarchy: boolean;
  type_system: string;
  parent_link_strategy: string;
}

export interface ConnectorDefinition {
  tool_key: string;
  display_name: string;
  auth_methods: string[];
  scope_picker_type: string;
  capabilities: ConnectorCapabilities;
}

export interface ScopeOption {
  id: string;
  label: string;
}

export interface ItemTypeField {
  id: string;
  name: string;
  required: boolean;
  has_default: boolean;
}

export interface ItemType {
  id: string;
  name: string;
  supports_children: boolean;
  fields: ItemTypeField[];
}

export interface DiscoveryResult {
  scope_options: ScopeOption[];
  item_types: ItemType[] | null;
  extras: Record<string, unknown>;
}

export interface CollectedState {
  remote_project?: string;
  discovery?: DiscoveryResult;
  [key: string]: unknown;
}

export interface WizardSessionData {
  id: string;
  tool_key: string;
  current_step: WizardStep;
  collected_state: CollectedState;
  expires_at: string;
}

/** Props every step component receives from the wizard shell. */
export interface StepProps {
  workspaceId: string;
  projectId: string;
  toolKey: string;
  wizardSessionId: string;
  connector: ConnectorDefinition;
  collectedState: CollectedState;
  /** Persists the step transition (PATCHes the session) then moves the shell
   * to the next step. `stateUpdate` is shallow-merged into collected_state. */
  onAdvance: (nextStep: WizardStep, stateUpdate?: Partial<CollectedState>) => void | Promise<void>;
}
