import { BadRequestException } from '@nestjs/common';
import { fieldContract, type FieldDefinition, type ReferencePresentation } from '@suzubase/shared-types';
import { z } from 'zod';
import { normalizeValue } from './field-values';
import { identifier } from './validation';
import { conditions } from './view-input';

export const referencePresentation = {
  displayFieldIds: z.array(identifier).max(30).refine((ids) => new Set(ids).size === ids.length).optional(),
  conditions: conditions.optional(),
  sort: z.strictObject({ fieldId: identifier, direction: z.enum(['asc', 'desc']) }).optional(),
};

export function normalizeReferencePresentation(config: ReferencePresentation, fields: FieldDefinition[]) {
  const definitions = new Map(fields.map((field) => [field.fieldId, field]));
  if (config.displayFieldIds?.some((id) => {
    const field = definitions.get(id);
    return !field || ['layout', 'lookup', 'related', 'attachment'].includes(field.type);
  })) throw new BadRequestException('Unsupported reference display field');
  if (config.sort) {
    const field = definitions.get(config.sort.fieldId);
    if (!field || !fieldContract[field.type].sort) throw new BadRequestException('Unsupported reference sort');
  }
  return config.conditions?.map((condition) => {
    const field = definitions.get(condition.fieldId);
    if (!field || !fieldContract[field.type].filter ||
        (condition.operator === 'current-user' && field.type !== 'user') ||
        (condition.operator === 'current-user-group' && field.type !== 'group')) {
      throw new BadRequestException('Unsupported reference condition');
    }
    if ('value' in condition) {
      const value = normalizeValue(field.type, condition.value, field.options);
      if (value === undefined) throw new BadRequestException('Invalid reference condition value');
      return { ...condition, value };
    }
    return condition;
  });
}
