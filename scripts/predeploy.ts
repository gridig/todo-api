// Single pre-deploy entrypoint. Railway runs `node dist/scripts/predeploy.js` as
// deploy.preDeployCommand — once per deploy, in the built image with the service
// env + private network, before the new version goes live.
//
// Why one script instead of a chained `A && B && C` string: a shell chain only
// gates correctly if the runner evaluates it in a shell. The 2026-07-10 incident
// shipped a release whose migrations never applied even though
// `preflight-roles && prisma migrate deploy` was configured — the migrate step
// effectively didn't run, so the app went live against an unmigrated schema and
// every register/login 500'd. Running the steps in one Node process with
// explicit exit codes removes that fragility and makes each gate loud in the
// deploy log.
//
// Each step aborts the release (non-zero exit → Railway keeps the previous
// version serving) on failure:
//   1. Roles present            — reuses runPreflight().
//   2. prisma migrate deploy    — apply pending migrations.
//   3. prisma migrate status    — assert the schema is fully up to date. Belt-
//      and-suspenders: catches a pending/failed state even if step 2 mis-reports
//      or targets the wrong database, so a release can never go live unmigrated.
//
// NOTE on multi-phase (expand → backfill → contract) migrations: those need an
// operator-run data backfill *between* migrations (e.g. the email-encryption
// rollout — scripts/backfill-email-crypto.ts). `migrate deploy` cannot run that
// backfill, so step 2 will fail and correctly block the release. Apply such
// migrations manually per docs/operations.md, then redeploy. That is the intended
// behaviour, not a bug in this gate.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runPreflight } from './preflight-roles.js';

interface PredeployLogger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// Run a subprocess, streaming its output to the deploy log. Returns 0 on success
// or a non-zero code (never null) so the caller can propagate an abort.
function runStep(label: string, cmd: string, args: string[], log: PredeployLogger): number {
  log.log(`predeploy: ${label} …`);
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.error) {
    log.error(`predeploy: ${label} could not start (${result.error.message}). Aborting release.`);
    return 1;
  }
  if (result.status !== 0) {
    const why = result.status === null ? `signal ${result.signal}` : `exit ${result.status}`;
    log.error(`predeploy: ${label} FAILED (${why}). Aborting release.`);
    return result.status ?? 1;
  }
  return 0;
}

export async function runPredeploy(
  log: PredeployLogger = console,
): Promise<number> {
  // 1. Roles the migrations + audit-log REVOKE depend on.
  const rolesCode = await runPreflight();
  if (rolesCode !== 0) return rolesCode;

  // 2. Apply pending migrations.
  const deployCode = runStep(
    'prisma migrate deploy',
    'pnpm',
    ['exec', 'prisma', 'migrate', 'deploy'],
    log,
  );
  if (deployCode !== 0) return deployCode;

  // 3. Verify the schema is fully current before letting the release proceed.
  const statusCode = runStep(
    'prisma migrate status',
    'pnpm',
    ['exec', 'prisma', 'migrate', 'status'],
    log,
  );
  if (statusCode !== 0) {
    log.error(
      'predeploy: database is not fully migrated after migrate deploy — refusing to release. ' +
        'If this is a multi-phase (expand→backfill→contract) migration, apply it manually with the ' +
        'required backfill per docs/operations.md, then redeploy.',
    );
    return statusCode;
  }

  log.log('predeploy: OK — roles present, migrations applied, schema up to date.');
  return 0;
}

// Run only when executed directly, so tests can import runPredeploy.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPredeploy().then(
    (code) => process.exit(code),
    (err) => {
      console.error('predeploy: unexpected failure:', err);
      process.exit(1);
    },
  );
}
