// Daily sample reset: wipe every sample record and re-create the seed set.
// Invoked by the suzubase-sample-reset systemd timer (04:00 JST) with the
// admin credentials in the environment. Thin wrapper over the seeder.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.execPath, [`${here}/seed-sample.mjs`, '--records-only'], {
  stdio: 'inherit', env: process.env,
});
process.exit(result.status ?? 1);
