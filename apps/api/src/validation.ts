import { BadRequestException } from '@nestjs/common';
import { z, ZodType } from 'zod';

export const identifier = z.uuid();

export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestException(result.error.issues.map(({ path, message }) => ({
      field: path.join('.'), message,
    })));
  }
  return result.data;
}

export function postgresErrorCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') return cause.code;
  return undefined;
}
