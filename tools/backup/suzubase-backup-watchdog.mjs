#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const backupDir = resolve(process.env.SUZUBASE_BACKUP_DIR ?? '/var/lib/suzubase/backups');
const statusPath = join(backupDir, 'status.json');
const thresholdHours = Number(process.env.SUZUBASE_BACKUP_MISSED_HOURS ?? 26);
if (!existsSync(statusPath)) {
  await run(process.execPath, [resolve(new URL('.', import.meta.url).pathname, 'suzubase-backup.mjs'), 'missed-schedule'],
    { env: process.env });
  process.exit(0);
}
const status = JSON.parse(readFileSync(statusPath, 'utf8'));
const last = status.recentSuccessAt ? Date.parse(status.recentSuccessAt) : 0;
if (!Number.isFinite(last) || Date.now() - last > thresholdHours * 60 * 60 * 1000) {
  await run(process.execPath, [resolve(new URL('.', import.meta.url).pathname, 'suzubase-backup.mjs'), 'missed-schedule'],
    { env: process.env });
}
