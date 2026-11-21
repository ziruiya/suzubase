import { appActions, fieldActions, recordActions } from '@suzubase/shared-types';
import { z } from 'zod';
import { identifier } from './validation';
import { conditions } from './view-input';

const directorySubject = z.strictObject({
  kind: z.enum(['user', 'organization', 'group']), id: identifier,
});
const recordSubject = z.union([directorySubject, z.strictObject({
  kind: z.enum(['user-field', 'organization-field', 'group-field']), id: identifier,
})]);

export const aclInput = z.strictObject({
  app: z.array(z.strictObject({ action: z.enum(appActions), subject: directorySubject })).max(100),
  record: z.array(z.strictObject({ action: z.enum(recordActions), subject: recordSubject, conditions })).max(100),
  field: z.array(z.strictObject({ action: z.enum(fieldActions), subject: directorySubject, fieldId: identifier })).max(200),
});
