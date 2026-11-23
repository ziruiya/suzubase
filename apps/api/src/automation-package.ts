import type { AutomationRuleConfig } from '@suzubase/db';

/**
 * P3-D wave 2 (M1 automation export/import): the automation section of the
 * M1 single-application package, stored as `data/automation.json`.
 *
 * Backward-compatible additive extension (brief §7): packages written
 * before this wave have no automation file and import with unchanged
 * semantics; packages written by this wave keep format version 1.0 and the
 * two formal restore outcomes (complete / pending completion).
 *
 * Hard rules encoded here and in the export/import services:
 *  - The section carries rule definitions, published (and draft/archived)
 *    rule versions, field references, application dependencies, the grant
 *    REQUIREMENT list and the non-sensitive part of webhook endpoint
 *    configuration. It NEVER carries webhook secret material: neither the
 *    plaintext secret nor the AES-256-GCM ciphertext stored at rest.
 *  - Run history is not part of the section: runs are never exported as
 *    replayable state and never imported (V-08: no history replay, no
 *    external action is invoked by an import).
 *  - Imported rules are always disabled drafts. Grants are requirements
 *    only; nothing in the package can make a grant effective in the
 *    target. Webhook endpoints are recreated as credential placeholders.
 */

export const AUTOMATION_PACKAGE_SCHEMA_VERSION = 1;

export interface AutomationGrantRequirement {
  sourceAppId: string;
  readableFieldIds: string[];
  targetAppIds: string[];
  writableFieldIds: string[];
  allowedOperations: string[];
}

export interface AutomationPackageVersion {
  version: number;
  schemaVersion: number;
  sourceSchemaVersion: number;
  status: 'draft' | 'published' | 'archived';
  trigger: AutomationRuleConfig['trigger'];
  conditions: AutomationRuleConfig['conditions'];
  actions: AutomationRuleConfig['actions'];
  /** What the source environment had approved for this version, expressed
   * as a requirement. Never an effective grant in the target. */
  grantRequirement: AutomationGrantRequirement | null;
}

export interface AutomationPackageRule {
  sourceRuleId: string;
  name: string;
  enabledInSource: boolean;
  currentVersion: number | null;
  archived: boolean;
  versions: AutomationPackageVersion[];
}

export interface AutomationPackageEndpoint {
  sourceEndpointId: string;
  name: string;
  url: string;
  policy: string;
  keyVersion: number;
  /** Always true: the target must supply a fresh signing secret. */
  credentialRequired: true;
  credentialPendingInSource: boolean;
  validatedInSource: boolean;
}

export interface AutomationPackage {
  schemaVersion: number;
  rules: AutomationPackageRule[];
  endpoints: AutomationPackageEndpoint[];
}

export type AutomationUnresolvedKind =
  | 'field' | 'target-field' | 'app' | 'user' | 'group'
  | 'workflow-state' | 'workflow-action' | 'webhook-endpoint';

export interface AutomationUnresolved {
  kind: AutomationUnresolvedKind;
  sourceId: string;
  /** Where the reference lives, e.g. `trigger.fieldId`, `actions[2].updates[0].fieldId`. */
  context: string;
  ruleSourceId?: string;
  version?: number;
}

/**
 * Reference resolvers used both by the real import (returns target ids)
 * and by the dry-run preview (returns a non-null marker for references
 * that will resolve). A null return means "unresolved": the reference is
 * reported explicitly, never silently dropped and never guessed.
 */
export interface AutomationResolvers {
  field(sourceId: string): string | null;
  targetField(appSourceId: string, sourceFieldId: string): string | null;
  app(sourceId: string): string | null;
  user(sourceId: string): string | null;
  group(sourceId: string): string | null;
  workflowState(sourceId: string): string | null;
  workflowAction(sourceId: string): string | null;
  endpoint(sourceId: string): string | null;
}

function templateFieldIds(text: string | undefined): string[] {
  return [...(text?.matchAll(/\{\{([A-Za-z0-9_-]+)\}\}/g) ?? [])].map((match) => match[1]);
}

/** Every field id a rule config reads (mirrors automation.ts fieldsFor). */
export function automationConfigFieldIds(config: AutomationRuleConfig): Set<string> {
  const ids = new Set<string>();
  const trigger = config.trigger;
  if (trigger.fieldId) ids.add(trigger.fieldId);
  if (trigger.dateRelative?.fieldId) ids.add(trigger.dateRelative.fieldId);
  for (const stage of [config.conditions.eventSnapshot, config.conditions.currentState]) {
    for (const group of stage.groups) for (const item of group.conditions) ids.add(item.fieldId);
  }
  for (const action of config.actions) {
    if (action.notify?.recipientFieldId) ids.add(action.notify.recipientFieldId);
    for (const text of [action.notify?.title, action.notify?.body]) {
      for (const id of templateFieldIds(text)) ids.add(id);
    }
    for (const update of action.updates ?? []) if (update.sourceFieldId) ids.add(update.sourceFieldId);
    for (const mapping of action.mappings ?? []) if (mapping.sourceFieldId) ids.add(mapping.sourceFieldId);
  }
  return ids;
}

/** Every application id a rule version depends on (its own app excluded by caller convention). */
export function automationVersionAppIds(version: AutomationPackageVersion): Set<string> {
  const ids = new Set<string>();
  for (const action of version.actions) if (action.targetAppId) ids.add(action.targetAppId);
  if (version.grantRequirement) {
    ids.add(version.grantRequirement.sourceAppId);
    for (const id of version.grantRequirement.targetAppIds) ids.add(id);
  }
  return ids;
}

export interface RemappedVersion {
  trigger: AutomationRuleConfig['trigger'];
  conditions: AutomationRuleConfig['conditions'];
  actions: AutomationRuleConfig['actions'];
  grantRequirement: AutomationGrantRequirement | null;
  unresolved: AutomationUnresolved[];
}

/**
 * Rewrite one rule version's configuration against the target environment.
 * References that resolve are replaced by their target ids; references
 * that do not resolve keep their source id (the rule stays a disabled
 * draft, so a dangling source id can never execute) and are listed in
 * `unresolved`. Recipient user/group ids that do not resolve are the one
 * exception: they are removed from the recipient list (a notification must
 * never be re-pointed at a guessed person) and listed in `unresolved`.
 */
export function remapAutomationVersion(
  version: AutomationPackageVersion,
  resolvers: AutomationResolvers,
  ruleSourceId: string,
): RemappedVersion {
  const unresolved: AutomationUnresolved[] = [];
  const seen = new Set<string>();
  const flag = (kind: AutomationUnresolvedKind, sourceId: string, context: string) => {
    const key = `${kind}:${sourceId}:${context}`;
    if (seen.has(key)) return;
    seen.add(key);
    unresolved.push({ kind, sourceId, context, ruleSourceId, version: version.version });
  };
  const field = (sourceId: string, context: string): string => {
    const target = resolvers.field(sourceId);
    if (target === null) { flag('field', sourceId, context); return sourceId; }
    return target;
  };
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const trigger = clone(version.trigger);
  if (trigger.fieldId) trigger.fieldId = field(trigger.fieldId, 'trigger.fieldId');
  if (trigger.dateRelative?.fieldId) {
    trigger.dateRelative.fieldId = field(trigger.dateRelative.fieldId, 'trigger.dateRelative.fieldId');
  }
  if (trigger.fromStateId) {
    const target = resolvers.workflowState(trigger.fromStateId);
    if (target === null) flag('workflow-state', trigger.fromStateId, 'trigger.fromStateId');
    else trigger.fromStateId = target;
  }
  if (trigger.toStateId) {
    const target = resolvers.workflowState(trigger.toStateId);
    if (target === null) flag('workflow-state', trigger.toStateId, 'trigger.toStateId');
    else trigger.toStateId = target;
  }

  const conditions = clone(version.conditions);
  for (const stageName of ['eventSnapshot', 'currentState'] as const) {
    const stage = conditions[stageName];
    stage.groups.forEach((group, groupIndex) => group.conditions.forEach((item, itemIndex) => {
      item.fieldId = field(item.fieldId, `conditions.${stageName}.groups[${groupIndex}].conditions[${itemIndex}].fieldId`);
    }));
  }

  const actions = clone(version.actions);
  actions.forEach((action, actionIndex) => {
    const at = `actions[${actionIndex}]`;
    let targetAppSourceId: string | null = null;
    if (action.targetAppId) {
      targetAppSourceId = action.targetAppId;
      const target = resolvers.app(action.targetAppId);
      if (target === null) flag('app', action.targetAppId, `${at}.targetAppId`);
      else action.targetAppId = target;
    }
    const targetField = (sourceId: string, context: string): string => {
      // Fields written on the rule's own application resolve through the
      // own-field map; fields on a target application resolve through that
      // application's map (a cross-application import's entity mapping).
      const target = targetAppSourceId === null
        ? resolvers.field(sourceId)
        : resolvers.targetField(targetAppSourceId, sourceId);
      if (target === null) { flag('target-field', sourceId, context); return sourceId; }
      return target;
    };
    if (action.targetFieldIds) {
      action.targetFieldIds = action.targetFieldIds.map((id, i) => targetField(id, `${at}.targetFieldIds[${i}]`));
    }
    if (action.notify) {
      const notify = action.notify;
      if (notify.recipientUserIds) {
        notify.recipientUserIds = notify.recipientUserIds.flatMap((id) => {
          const target = resolvers.user(id);
          if (target === null) { flag('user', id, `${at}.notify.recipientUserIds`); return []; }
          return [target];
        });
      }
      if (notify.recipientGroupIds) {
        notify.recipientGroupIds = notify.recipientGroupIds.flatMap((id) => {
          const target = resolvers.group(id);
          if (target === null) { flag('group', id, `${at}.notify.recipientGroupIds`); return []; }
          return [target];
        });
      }
      if (notify.recipientFieldId) notify.recipientFieldId = field(notify.recipientFieldId, `${at}.notify.recipientFieldId`);
      for (const key of ['title', 'body'] as const) {
        const text = notify[key];
        if (!text) continue;
        notify[key] = text.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (whole, id: string) => {
          const target = resolvers.field(id);
          if (target === null) { flag('field', id, `${at}.notify.${key}`); return whole; }
          return `{{${target}}}`;
        });
      }
    }
    (action.updates ?? []).forEach((update, i) => {
      update.fieldId = targetField(update.fieldId, `${at}.updates[${i}].fieldId`);
      if (update.sourceFieldId) update.sourceFieldId = field(update.sourceFieldId, `${at}.updates[${i}].sourceFieldId`);
    });
    (action.mappings ?? []).forEach((mapping, i) => {
      mapping.targetFieldId = targetField(mapping.targetFieldId, `${at}.mappings[${i}].targetFieldId`);
      if (mapping.sourceFieldId) mapping.sourceFieldId = field(mapping.sourceFieldId, `${at}.mappings[${i}].sourceFieldId`);
    });
    if (action.workflowActionId) {
      const target = resolvers.workflowAction(action.workflowActionId);
      if (target === null) flag('workflow-action', action.workflowActionId, `${at}.workflowActionId`);
      else action.workflowActionId = target;
    }
    if (action.webhook?.endpointId) {
      const target = resolvers.endpoint(action.webhook.endpointId);
      if (target === null) flag('webhook-endpoint', action.webhook.endpointId, `${at}.webhook.endpointId`);
      else action.webhook.endpointId = target;
    }
  });

  let grantRequirement: AutomationGrantRequirement | null = null;
  if (version.grantRequirement) {
    const requirement = clone(version.grantRequirement);
    const sourceApp = resolvers.app(requirement.sourceAppId);
    if (sourceApp === null) flag('app', requirement.sourceAppId, 'grantRequirement.sourceAppId');
    else requirement.sourceAppId = sourceApp;
    requirement.readableFieldIds = requirement.readableFieldIds.map((id, i) =>
      field(id, `grantRequirement.readableFieldIds[${i}]`));
    requirement.targetAppIds = requirement.targetAppIds.map((id, i) => {
      const target = resolvers.app(id);
      if (target === null) { flag('app', id, `grantRequirement.targetAppIds[${i}]`); return id; }
      return target;
    });
    requirement.writableFieldIds = requirement.writableFieldIds.map((id, i) => {
      // Writable fields may live on the source app or on a target app; try
      // the own-field map first, then every known target application's map.
      const own = resolvers.field(id);
      if (own !== null) return own;
      for (const appId of version.grantRequirement!.targetAppIds) {
        const target = resolvers.targetField(appId, id);
        if (target !== null) return target;
      }
      flag('target-field', id, `grantRequirement.writableFieldIds[${i}]`);
      return id;
    });
    grantRequirement = requirement;
  }

  return { trigger, conditions, actions, grantRequirement, unresolved };
}
