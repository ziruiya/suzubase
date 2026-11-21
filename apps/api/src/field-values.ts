import { FieldOption, FieldType, multiOptionFieldTypes, optionFieldTypes } from '@suzubase/shared-types';
import { z } from 'zod';
import { identifier } from './validation';

const localDate = z.iso.date();
const localTime = z.iso.time({ precision: 0 });
const offsetDateTime = z.iso.datetime({ offset: true });
const email = z.email();

export function normalizeDecimal(value: string): string | undefined {
  if (value.length > 200) return undefined;
  const parts = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!parts || parts[0] !== value) return undefined;
  const [, sign, integer, fraction = ''] = parts;
  const whole = integer.replace(/^0+(?=\d)/, '');
  const partial = fraction.replace(/0+$/, '');
  const prefix = sign === '-' && (whole !== '0' || partial) ? '-' : '';
  return partial ? `${prefix}${whole}.${partial}` : `${prefix}${whole}`;
}

export function normalizeValue(type: FieldType, value: string, options: FieldOption[]) {
  if (/[\x00\p{Surrogate}]/u.test(value)) return undefined;
  if (type !== 'multiline' && /[\r\n\u2028\u2029]/u.test(value)) return undefined;
  if (type === 'text' || type === 'multiline') return value;
  if (type === 'number') return normalizeDecimal(value);
  const active = new Set(options.filter(({ disabled }) => !disabled).map(({ value }) => value));
  if (multiOptionFieldTypes.has(type)) {
    try {
      const values: unknown = JSON.parse(value);
      if (!Array.isArray(values) || !values.every((item) => typeof item === 'string' && active.has(item))) return undefined;
      return JSON.stringify(options.filter((option) => values.includes(option.value)).map((option) => option.value));
    } catch {
      return undefined;
    }
  }
  if (optionFieldTypes.has(type)) return active.has(value) ? value : undefined;
  switch (type) {
    case 'date': return localDate.safeParse(value).success ? value : undefined;
    case 'time': {
      const seconds = value.length === 5 ? value + ':00' : value;
      return localTime.safeParse(seconds).success ? seconds : undefined;
    }
    case 'datetime': {
      if (!offsetDateTime.safeParse(value).success) return undefined;
      const timestamp = new Date(value);
      return Number.isFinite(+timestamp) ? timestamp.toISOString() : undefined;
    }
    case 'url':
      try {
        const url = new URL(value);
        return /^https?:\/\//i.test(value) && !url.username && !url.password ? url.href : undefined;
      } catch {
        return undefined;
      }
    case 'phone': return /^\+?[0-9０-９()（）\-－\s]+$/u.test(value) && /[0-9０-９]/u.test(value) ? value : undefined;
    case 'email': return email.safeParse(value).success ? value : undefined;
    case 'user':
    case 'organization':
    case 'group':
      return identifier.safeParse(value).success ? value.toLowerCase() : undefined;
  }
}
