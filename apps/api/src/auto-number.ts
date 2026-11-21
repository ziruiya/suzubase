import { BadRequestException, ConflictException } from '@nestjs/common';
import { autoNumberCounters, issuedAutoNumbers, sql, TenantContext, TenantTransaction } from '@suzubase/db';
import { AutoNumberConfiguration, RecordData } from '@suzubase/shared-types';

export const maxAutoNumber = 999999999999999999n;

export function numberScope(configuration: AutoNumberConfiguration, data: RecordData) {
  if (configuration.scopeFieldId === null) return '';
  const value = data[configuration.scopeFieldId];
  if (!value || Buffer.byteLength(value) > 1000) {
    throw new BadRequestException([{ field: configuration.scopeFieldId, message: 'A valid numbering scope is required' }]);
  }
  return value;
}

export function importedAutoNumber(configuration: AutoNumberConfiguration, fieldId: string, supplied: string) {
  const digits = supplied.slice(configuration.prefix.length);
  const valid = supplied.startsWith(configuration.prefix) && /^[0-9]{1,32}$/.test(digits);
  const number = valid ? BigInt(digits) : 0n;
  if (number < 1n || number > maxAutoNumber ||
    number.toString().padStart(configuration.padding, '0') !== digits) {
    throw new BadRequestException([{ field: fieldId, message: 'Invalid preserved automatic number' }]);
  }
  return number;
}

export async function assignAutoNumber(
  tx: TenantTransaction, context: TenantContext, appId: string, fieldId: string,
  configuration: AutoNumberConfiguration, scope: string, supplied?: string,
) {
  if (!configuration.enabled && supplied === undefined) return undefined;
  const identity = { tenantId: context.tenantId, appId, fieldId, scope };
  const target = [autoNumberCounters.tenantId, autoNumberCounters.appId, autoNumberCounters.fieldId, autoNumberCounters.scope];
  const initial = BigInt(configuration.nextValue);
  const suppliedNumber = supplied === undefined ? undefined : importedAutoNumber(configuration, fieldId, supplied);
  const next = suppliedNumber === undefined ? initial + 1n : (suppliedNumber >= initial ? suppliedNumber + 1n : initial);
  const [counter] = await tx.insert(autoNumberCounters).values({ ...identity, nextValue: next }).onConflictDoUpdate({
    target,
    set: { nextValue: suppliedNumber === undefined
      ? sql`${autoNumberCounters.nextValue} + 1`
      : sql`GREATEST(${autoNumberCounters.nextValue}, ${next})` },
  }).returning({ next: autoNumberCounters.nextValue });
  const number = suppliedNumber ?? counter.next - 1n;
  if (number > maxAutoNumber) throw new ConflictException('Automatic number sequence is exhausted');
  const [inserted] = await tx.insert(issuedAutoNumbers).values({ ...identity, number }).onConflictDoNothing()
    .returning({ number: issuedAutoNumbers.number });
  if (!inserted) throw new ConflictException([{ field: fieldId, message: 'Automatic number has already been issued' }]);
  return configuration.prefix + number.toString().padStart(configuration.padding, '0');
}
