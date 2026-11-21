import { z } from 'zod';
import { identifier } from './validation';

export const conditions = z.array(z.union([
  z.strictObject({
    fieldId: identifier, operator: z.enum(['eq', 'ne']),
    value: z.string().max(4000).refine((value) => !/[\x00\p{Surrogate}]/u.test(value)),
  }),
  z.strictObject({ fieldId: identifier, operator: z.enum(['empty', 'nonempty', 'current-user', 'current-user-group']) }),
])).max(20);

export const viewInput = z.strictObject({
  name: z.string().trim().min(1).max(120).refine((value) => !/[\x00\p{Surrogate}]/u.test(value)),
  columns: z.array(z.strictObject({ fieldId: identifier, width: z.int().min(80).max(800) })).max(100)
    .refine((columns) => new Set(columns.map(({ fieldId }) => fieldId)).size === columns.length),
  aggregateFields: z.array(identifier).max(10).refine((ids) => new Set(ids).size === ids.length).optional(),
  conditions,
  workflowState: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  assignedToMe: z.boolean().optional(),
  pastDateFieldId: identifier.optional(),
  sort: z.strictObject({ fieldId: identifier, direction: z.enum(['asc', 'desc']) }).optional(),
});
