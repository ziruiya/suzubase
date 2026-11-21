import Decimal from 'decimal.js';
import { formulaOperators, type FieldType, type Formula, type RecordData } from '@suzubase/shared-types';
import { z } from 'zod';
import { normalizeDecimal } from './field-values';
import { identifier } from './validation';

const arithmetic = Decimal.clone({ precision: 220, minE: -220, maxE: 220 });
type Definition = { fieldId: string; type: FieldType; formula: Formula | null };
type Operand = { kind: 'number' | 'text'; value: string | null };

export const formulaInput = z.array(z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('field'), fieldId: identifier }),
  z.strictObject({ kind: z.literal('number'), value: z.string().refine((value) => normalizeDecimal(value) !== undefined) }),
  z.strictObject({ kind: z.literal('text'), value: z.string().max(1000).refine((value) => !/[\x00\p{Surrogate}]/u.test(value)) }),
  z.strictObject({ kind: z.literal('operator'), operator: z.enum(formulaOperators) }),
])).min(1).max(64);

function evaluate(formula: Formula, readField: (id: string) => Operand): Operand {
  const stack: Operand[] = [];
  for (const token of formula) {
    if (token.kind !== 'operator') {
      stack.push(token.kind === 'field' ? readField(token.fieldId) : token);
      continue;
    }
    const right = stack.pop();
    const left = stack.pop();
    if (!left || !right) throw new Error('An operator needs two operands');
    if (token.operator === '&') {
      const value = (left.value ?? '') + (right.value ?? '');
      stack.push({ kind: 'text', value: value.length <= 10_000 ? value : null });
      continue;
    }
    if (left.kind !== 'number' || right.kind !== 'number') throw new Error('Arithmetic requires numeric operands');
    const operation = { '+': 'plus', '-': 'minus', '*': 'times', '/': 'dividedBy' } as const;
    const value = left.value === null || right.value === null ? null :
      new arithmetic(left.value)[operation[token.operator]](right.value);
    stack.push({ kind: 'number', value: value?.isFinite() ? value.toFixed() : null });
  }
  if (stack.length !== 1) throw new Error('A formula must produce one result');
  return stack[0];
}

function readOperand(fields: ReadonlyMap<string, Definition>, data: RecordData, id: string): Operand {
  const field = fields.get(id);
  if (!field || ['layout', 'calculation', 'attachment', 'richText', 'related', 'table'].includes(field.type)) {
    throw new Error('Unsupported or missing formula reference ' + id);
  }
  const value = data[id] ?? null;
  const numeric = field.type === 'number';
  return { kind: numeric ? 'number' : 'text', value: numeric && value !== null ? normalizeDecimal(value) ?? null : value };
}

export function formulaProblems(draft: Definition[], published: Definition[]) {
  const current = new Map(draft.map((field) => [field.fieldId, field]));
  const previous = new Map(published.map((field) => [field.fieldId, field.type]));
  const problems: { fieldId: string; reason: string }[] = [];
  for (const field of draft) {
    if (!field.formula) continue;
    try {
      evaluate(field.formula, (id) => {
        if (previous.has(id) && previous.get(id) !== current.get(id)?.type) {
          throw new Error('Formula references a deleted field or changed field type ' + id);
        }
        return readOperand(current, {}, id);
      });
    } catch (error) {
      problems.push({ fieldId: field.fieldId, reason: (error as Error).message });
    }
  }
  return problems;
}

export function calculateFields(definitions: Definition[], data: RecordData) {
  const fields = new Map(definitions.map((field) => [field.fieldId, field]));
  for (const field of definitions) {
    if (!field.formula) continue;
    const result = evaluate(field.formula, (id) => readOperand(fields, data, id));
    if (result.value !== null) data[field.fieldId] = result.value;
  }
}
