import type { ViewCondition } from './views';

export const notificationPlaceholders = /\{\{([0-9a-f-]{36})\}\}/gi;

export const notificationTriggers = ['created', 'updated', 'workflow-action', 'workflow-state', 'comment-created', 'mention'] as const;
export type NotificationTrigger = (typeof notificationTriggers)[number];
export type NotificationRecipient =
  | { kind: 'user' | 'organization' | 'group' | 'user-field'; id: string }
  | { kind: 'creator' | 'assignees' | 'comment-author' };

export interface NotificationRule {
  id: string;
  enabled: boolean;
  trigger: NotificationTrigger;
  actionId?: string;
  stateCode?: string;
  conditions: ViewCondition[];
  recipients: NotificationRecipient[];
  title: string;
  body: string;
}

export interface NotificationDelivery {
  userId: string;
  ruleKey: string;
  title: string;
  body: string;
}
