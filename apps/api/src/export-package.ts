import { createHash } from 'node:crypto';
import { strToU8, unzipSync, zipSync } from 'fflate';

/**
 * SuzuBase M1 single-application package format, version 1.0.
 * (Contracts ch.4; Gate 3 brief G3-01..G3-05 and derivation decisions 3, 6, 10, 12.)
 *
 * A package is ONE zip archive. Layout:
 *   manifest.json                  - the manifest below; the only validity anchor
 *   data/app.json                  - app metadata/settings + app code (G3-02)
 *   data/schema.json               - per-version resolved field definitions, raw
 *                                    field-edit snapshots, layouts, views (G3-02)
 *   data/workflows.json            - every workflow definition version + graph (G3-02)
 *   data/records.json              - all records (incl. soft-deleted) + workflow
 *                                    state/assignees per record (G3-03)
 *   data/table-rows.json           - all subtable rows with their own row_id (G3-03)
 *   data/references.json           - record_references rows (lookup snapshots) (G3-03)
 *   data/comments.json             - comments; deleted comments carry metadata
 *                                    and a deletion marker only, never a body (G3-04)
 *   data/history.json              - record events + workflow events, event level,
 *                                    migration-source chain preserved as-is (G3-04)
 *   data/config.json               - three-layer ACL, notification rules,
 *                                    lookup/related configs, API token metadata (G3-05)
 *   data/directory.json            - source user/group/organization identities
 *                                    referenced by the package (mapping input)
 *   data/automation.json           - P3-D wave 2: automation rules, rule
 *                                    versions, grant REQUIREMENTS and the
 *                                    non-sensitive webhook endpoint config.
 *                                    Never secret material (neither plaintext
 *                                    nor ciphertext); absent in old packages.
 *   attachments/<fileId>/v<version>/body - attachment file bodies (G3-03)
 *
 * Validity rules (contracts 4 SS4.6):
 *  - Only a package whose manifest.state is "sealed" is valid. A half package
 *    (state "building", or a zip without manifest.json) must never be imported.
 *  - Before sealing, expected counts (declared by the collectors before the
 *    payload is assembled) are reconciled against actual counts (counted in the
 *    assembled payload). Any mismatch refuses the seal and reports the diff.
 *  - Every payload file carries its SHA-256 in manifest.files. The hash proves
 *    the package was not modified; it does NOT prove completeness (SS4.6.5) -
 *    completeness is the count reconciliation plus the evidence chain.
 *  - The package contains complete business data. It is NOT encrypted
 *    (decision 10): handlers must treat it as sensitive data. The notice text
 *    below is shown on the export confirmation surface and in reports.
 */
export const PACKAGE_FORMAT_VERSION = '1.0';
/**
 * Minimum program version written into every exported package.
 * Raised 1.0.0 -> 1.1.0 at the P4 merge finalization (brief-p4 §2): P4
 * packages can carry category trees/assignments (schema.json/records.json
 * additive keys) and subtable attachment references, which pre-P4
 * importers would silently drop or misread. The format itself is
 * unchanged (still '1.0', same files, additive keys only), so the floor
 * is the lever: pre-P4 deployments (PROGRAM_VERSION 1.0.0) reject new
 * packages explicitly at the import preflight gate instead of importing
 * them partially. Packages exported before P4 carry '1.0.0' and stay
 * importable here (additive compatibility).
 */
export const MINIMUM_PROGRAM_VERSION = '1.1.0';
export const SENSITIVE_DATA_NOTICE =
  'This package contains complete business data (records, comments and history). Store and transfer it as sensitive data. Checksums prove the package was not modified; they are not a confidentiality measure.';

export const OBJECT_TYPES = [
  'apps', 'appVersions', 'fields', 'fieldVersionSnapshots', 'deletedFields', 'views',
  'workflowVersions', 'records', 'tableRows', 'references', 'attachments',
  'attachmentVersions', 'comments', 'historyEvents', 'workflowEvents',
  'aclEntries', 'notificationRules', 'apiTokenMetadata', 'userReferences',
  'groupReferences', 'organizationReferences',
  'automationRules', 'automationRuleVersions', 'automationWebhookEndpoints',
] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];
export type ObjectCounts = Record<ObjectType, number>;

export function emptyCounts(): ObjectCounts {
  return Object.fromEntries(OBJECT_TYPES.map((type) => [type, 0])) as ObjectCounts;
}

/** Objects that exist in the format but may be absent/unsupported per source app. */
export type InclusionState = 'included' | 'absent' | 'unsupported';

export interface PackageManifest {
  formatVersion: typeof PACKAGE_FORMAT_VERSION;
  minimumProgramVersion: string;
  state: 'building' | 'sealed';
  exportId: string;
  sourceInstanceId: string;
  sourceTenantId: string;
  sourceAppId: string;
  sourceAppCode: string;
  exportedAt: string;
  /** Consistency snapshot cutoff (decision 12): nothing after this instant is in the package. */
  snapshotCutoff: string;
  counts: { expected: ObjectCounts; actual: ObjectCounts };
  excluded: { temporaryAttachments: number; purgedAttachments: number };
  inclusion: Record<string, InclusionState>;
  files: { path: string; sha256: string; bytes: number }[];
  attachments: { fileId: string; version: number; sha256: string; bytes: number; state: string; name: string; contentType: string }[];
  sensitiveDataNotice: string;
}

export function sha256(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface CountDiff { type: ObjectType; expected: number; actual: number }

/** Pre-seal reconciliation (G3-01): returns every mismatching object type. */
export function reconcileCounts(expected: ObjectCounts, actual: ObjectCounts): CountDiff[] {
  // Missing keys read as 0: manifests written before the automation
  // section existed carry no automation counts, and they must still
  // reconcile against a payload counted by current code (and vice versa).
  return OBJECT_TYPES.filter((type) => (expected[type] ?? 0) !== (actual[type] ?? 0))
    .map((type) => ({ type, expected: expected[type] ?? 0, actual: actual[type] ?? 0 }));
}

export interface PackagePayload {
  manifestBase: Omit<PackageManifest, 'state' | 'counts' | 'files'> & {
    counts: { expected: ObjectCounts };
  };
  /** path -> body for every data/* file (manifest.json is generated). */
  files: Record<string, string>;
  /** storage path inside the zip -> body */
  attachmentBodies: Record<string, Buffer>;
}

/** Assemble + reconcile + seal. Throws with the diff when counts disagree. */
export function sealPackage(payload: PackagePayload): { archive: Buffer; manifest: PackageManifest } {
  const counted = countPayload(payload);
  const diffs = reconcileCounts(payload.manifestBase.counts.expected, counted);
  if (diffs.length) {
    throw new Error('Export count reconciliation failed: ' +
      diffs.map(({ type, expected, actual: a }) => `${type} expected ${expected} actual ${a}`).join('; '));
  }
  const entries: Record<string, Uint8Array> = {};
  const fileEntries: PackageManifest['files'] = [];
  for (const [path, body] of Object.entries(payload.files)) {
    const bytes = strToU8(body);
    entries[path] = bytes;
    fileEntries.push({ path, sha256: sha256(bytes), bytes: bytes.length });
  }
  for (const [path, body] of Object.entries(payload.attachmentBodies)) {
    entries[path] = body;
    fileEntries.push({ path, sha256: sha256(body), bytes: body.length });
  }
  fileEntries.sort((a, b) => a.path.localeCompare(b.path));
  const manifest: PackageManifest = {
    ...payload.manifestBase,
    state: 'sealed',
    counts: { expected: payload.manifestBase.counts.expected, actual: counted },
    files: fileEntries,
  };
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return { archive: Buffer.from(zipSync(entries, { level: 6 })), manifest };
}

/** Count the objects actually present in an assembled payload. */
export function countPayload(payload: PackagePayload): ObjectCounts {
  const counts = emptyCounts();
  const read = <T,>(path: string): T | undefined => {
    const body = payload.files[path];
    return body === undefined ? undefined : JSON.parse(body) as T;
  };
  const app = read<{ app: unknown }>('data/app.json');
  counts.apps = app?.app ? 1 : 0;
  const schema = read<{ versions: unknown[]; fields: unknown[]; deletedFields: unknown[]; views: unknown[] }>('data/schema.json');
  counts.appVersions = schema?.versions.length ?? 0;
  counts.fieldVersionSnapshots = schema?.versions.length ?? 0;
  counts.fields = schema?.fields.length ?? 0;
  counts.deletedFields = schema?.deletedFields.length ?? 0;
  counts.views = schema?.views.length ?? 0;
  const workflows = read<{ definitions: unknown[] }>('data/workflows.json');
  counts.workflowVersions = workflows?.definitions.length ?? 0;
  const records = read<{ records: unknown[] }>('data/records.json');
  counts.records = records?.records.length ?? 0;
  const rows = read<{ rows: unknown[] }>('data/table-rows.json');
  counts.tableRows = rows?.rows.length ?? 0;
  const references = read<{ references: unknown[] }>('data/references.json');
  counts.references = references?.references.length ?? 0;
  const manifestBase = payload.manifestBase;
  counts.attachments = manifestBase.attachments.length;
  counts.attachmentVersions = manifestBase.attachments.length;
  const comments = read<{ comments: unknown[] }>('data/comments.json');
  counts.comments = comments?.comments.length ?? 0;
  const history = read<{ recordEvents: unknown[]; workflowEvents: unknown[] }>('data/history.json');
  counts.historyEvents = history?.recordEvents.length ?? 0;
  counts.workflowEvents = history?.workflowEvents.length ?? 0;
  const config = read<{ acl: { app: unknown[]; record: unknown[]; field: unknown[] }; notificationRules: unknown[]; apiTokens: unknown[] }>('data/config.json');
  counts.aclEntries = (config?.acl.app.length ?? 0) + (config?.acl.record.length ?? 0) + (config?.acl.field.length ?? 0);
  counts.notificationRules = config?.notificationRules.length ?? 0;
  counts.apiTokenMetadata = config?.apiTokens.length ?? 0;
  const automation = read<{ rules: { versions: unknown[] }[]; endpoints: unknown[] }>('data/automation.json');
  counts.automationRules = automation?.rules.length ?? 0;
  counts.automationRuleVersions = automation?.rules.reduce((sum, rule) => sum + rule.versions.length, 0) ?? 0;
  counts.automationWebhookEndpoints = automation?.endpoints.length ?? 0;
  const directory = read<{ users: unknown[]; groups: unknown[]; organizations: unknown[] }>('data/directory.json');
  counts.userReferences = directory?.users.length ?? 0;
  counts.groupReferences = directory?.groups.length ?? 0;
  counts.organizationReferences = directory?.organizations.length ?? 0;
  return counts;
}

export interface PackageVerification {
  manifest: PackageManifest;
  problems: string[];
}

/**
 * Verify a sealed package: manifest present + sealed, format version,
 * every listed file present with matching SHA-256, attachment triples match
 * their bodies, and manifest counts reconcile with the payload contents.
 * Used by tests and (Wave B) by import pre-validation.
 */
export function verifyPackage(archive: Buffer): PackageVerification {
  const problems: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(archive));
  } catch {
    return { manifest: undefined as never, problems: ['Archive is not a readable zip'] };
  }
  const manifestBody = entries['manifest.json'];
  if (!manifestBody) return { manifest: undefined as never, problems: ['manifest.json is missing: not a sealed package'] };
  const manifest = JSON.parse(Buffer.from(manifestBody).toString('utf8')) as PackageManifest;
  if (manifest.state !== 'sealed') problems.push(`Package state is ${manifest.state}, not sealed`);
  if (manifest.formatVersion !== PACKAGE_FORMAT_VERSION) {
    problems.push(`Unsupported package format version ${manifest.formatVersion}`);
  }
  for (const file of manifest.files) {
    const body = entries[file.path];
    if (!body) { problems.push(`Missing file ${file.path}`); continue; }
    if (body.length !== file.bytes) problems.push(`Size mismatch for ${file.path}`);
    if (sha256(body) !== file.sha256) problems.push(`SHA-256 mismatch for ${file.path}`);
  }
  for (const attachment of manifest.attachments) {
    const path = `attachments/${attachment.fileId}/v${attachment.version}/body`;
    const body = entries[path];
    if (!body) { problems.push(`Missing attachment body ${path}`); continue; }
    if (sha256(body) !== attachment.sha256) problems.push(`Attachment SHA-256 mismatch for ${attachment.fileId} v${attachment.version}`);
  }
  const files: Record<string, string> = {};
  for (const [path, body] of Object.entries(entries)) {
    if (path.startsWith('data/')) files[path] = Buffer.from(body).toString('utf8');
  }
  const counted = countPayload({ manifestBase: manifest, files, attachmentBodies: {} });
  for (const diff of reconcileCounts(manifest.counts.actual, counted)) {
    problems.push(`Count mismatch in package: ${diff.type} manifest ${diff.expected} payload ${diff.actual}`);
  }
  return { manifest, problems };
}
