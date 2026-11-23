import { BadRequestException } from '@nestjs/common';
import { and, eq, inArray, recordCategories, type TenantContext, type TenantTransaction } from '@suzubase/db';
import {
  categoryDepthLimit, categoryNodeLimit, type CategoryConfiguration,
} from '@suzubase/shared-types';
import { z } from 'zod';
import { identifier } from './validation';

/**
 * P4-T1 categories. The tree lives in the versioned
 * app_versions.category_configuration JSONB; assignments live in
 * record_categories and reference nodes by immutable id (never by name:
 * kintone allows same-level duplicate names, so a name is not an identity).
 */

export const categoryNodeInput = z.strictObject({
  id: identifier,
  parentId: identifier.nullable(),
  name: z.string().min(1).max(64),
  sortOrder: z.int().min(0).max(1000000),
});
export const categoryConfigurationInput = z.strictObject({
  enabled: z.boolean(),
  nodes: z.array(categoryNodeInput).max(categoryNodeLimit),
});
export const categoryIdsInput = z.array(identifier).max(categoryNodeLimit)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate category ids');

const categoryConfigurationReply = z.object({
  enabled: z.boolean(),
  nodes: z.array(z.object({
    id: z.uuid(), parentId: z.uuid().nullable(), name: z.string(), sortOrder: z.int(),
  })),
});

export const categoryHttp = { categoryConfigurationInput, categoryIdsInput, reply: categoryConfigurationReply };

function depthOf(nodes: z.infer<typeof categoryNodeInput>[], node: z.infer<typeof categoryNodeInput>,
  byId: Map<string, z.infer<typeof categoryNodeInput>>): number {
  let depth = 1;
  let current = node;
  const seen = new Set<string>([node.id]);
  while (current.parentId) {
    const parent = byId.get(current.parentId);
    if (!parent || seen.has(parent.id)) return Number.POSITIVE_INFINITY;
    seen.add(parent.id);
    depth++;
    current = parent;
  }
  return depth;
}

/** Structural validation of a submitted tree (ids unique, parents exist, acyclic, <=5 levels). */
export function validateCategoryTree(input: z.infer<typeof categoryConfigurationInput>): CategoryConfiguration {
  const byId = new Map<string, z.infer<typeof categoryNodeInput>>();
  for (const node of input.nodes) {
    if (byId.has(node.id)) throw new BadRequestException(`Duplicate category id ${node.id}`);
    byId.set(node.id, node);
  }
  for (const node of input.nodes) {
    if (node.parentId && !byId.has(node.parentId)) {
      throw new BadRequestException(`Category ${node.id} references a missing parent`);
    }
    if (depthOf(input.nodes, node, byId) > categoryDepthLimit) {
      throw new BadRequestException(`Category tree exceeds ${categoryDepthLimit} levels`);
    }
  }
  return {
    enabled: input.enabled,
    nodes: input.nodes.map(({ id, parentId, name, sortOrder }) => ({ id, parentId, name, sortOrder })),
  };
}

/**
 * GAIA_CD07 mirror: a category node that still has records cannot be
 * removed. Checked against record_categories at draft-edit time and again
 * at publish (assignments may have been added in between).
 */
export async function categoryRemovalProblems(
  tx: TenantTransaction, context: TenantContext, appId: string,
  before: CategoryConfiguration, after: CategoryConfiguration,
): Promise<{ fieldId: string; categoryId: string; dependency: 'category'; reason: string }[]> {
  const kept = new Set(after.nodes.map(({ id }) => id));
  const removed = before.nodes.filter(({ id }) => !kept.has(id));
  if (!removed.length) return [];
  const rows = await tx.select({ categoryId: recordCategories.categoryId }).from(recordCategories)
    .where(and(eq(recordCategories.tenantId, context.tenantId), eq(recordCategories.appId, appId),
      inArray(recordCategories.categoryId, removed.map(({ id }) => id))));
  const occupied = new Set(rows.map(({ categoryId }) => categoryId));
  return removed.filter(({ id }) => occupied.has(id)).map(({ id, name }) => ({
    fieldId: '', categoryId: id, dependency: 'category' as const,
    reason: `Category "${name}" still has records; clear its assignments before removing it`,
  }));
}

/** Validate a record's category assignment set against the published tree. */
export function assertCategoryAssignments(configuration: CategoryConfiguration, categoryIds: string[]) {
  if (!categoryIds.length) return;
  if (!configuration.enabled) {
    throw new BadRequestException('Categories are not enabled for this application');
  }
  const known = new Set(configuration.nodes.map(({ id }) => id));
  for (const id of categoryIds) {
    if (!known.has(id)) throw new BadRequestException(`Unknown category ${id}`);
  }
}

export async function replaceRecordCategories(
  tx: TenantTransaction, context: TenantContext, appId: string, recordId: string, categoryIds: string[],
) {
  const scope = and(eq(recordCategories.tenantId, context.tenantId), eq(recordCategories.appId, appId),
    eq(recordCategories.recordId, recordId));
  await tx.delete(recordCategories).where(scope);
  if (categoryIds.length) {
    await tx.insert(recordCategories).values(categoryIds.map((categoryId) => ({
      tenantId: context.tenantId, appId, recordId, categoryId,
    })));
  }
}

export async function recordCategoryIds(
  tx: TenantTransaction, context: TenantContext, appId: string, recordIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>(recordIds.map((id) => [id, []]));
  if (!recordIds.length) return result;
  const rows = await tx.select({ recordId: recordCategories.recordId, categoryId: recordCategories.categoryId })
    .from(recordCategories).where(and(eq(recordCategories.tenantId, context.tenantId),
      eq(recordCategories.appId, appId), inArray(recordCategories.recordId, recordIds)));
  for (const { recordId, categoryId } of rows) result.get(recordId)?.push(categoryId);
  return result;
}
