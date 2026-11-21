import type { ViewCondition } from './views';

export const workflowComparisonOperators = ['lt', 'lte', 'gt', 'gte'] as const;
export type WorkflowCondition = ViewCondition | {
  fieldId: string;
  operator: (typeof workflowComparisonOperators)[number];
  value: string;
};

export type AssigneeSource =
  | { kind: 'user' | 'organization' | 'group' | 'user-field'; id: string }
  | { kind: 'creator' | 'previous' };

export interface WorkflowState {
  id: string;
  code: string;
  name: string;
  terminal: boolean;
  initial: boolean;
  assignees: AssigneeSource[];
}

export interface WorkflowAction {
  id: string;
  name: string;
  fromStateId: string;
  toStateId: string;
  conditions: WorkflowCondition[];
  assignees: AssigneeSource[];
}

export interface WorkflowGraph {
  states: WorkflowState[];
  actions: WorkflowAction[];
}

export interface WorkflowDefinition extends WorkflowGraph {
  version: number;
  status: 'draft' | 'published';
}
