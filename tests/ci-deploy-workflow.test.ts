import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml') as { load: (text: string) => {
  jobs: Record<string, {
    needs?: string | string[]
    if?: string
    strategy?: { 'fail-fast'?: boolean; matrix: { include: Array<{ team_id: number; host: string; service: string }> } }
    steps: Array<{ name?: string; run?: string; uses?: string; if?: string; with?: { script?: string } }>
  }>
} }
const source = readFileSync('.github/workflows/deploy.yml', 'utf8')
const workflow = yaml.load(source)
const preflight = workflow.jobs['worker-preflight']
const remote = workflow.jobs['deploy-workers']
assert.ok(preflight, 'remote access/identity preflight must run before primary changes')
assert.ok(remote, 'CI must deploy workers to their designated remote host')
assert.deepEqual(preflight.strategy?.matrix, remote.strategy?.matrix, 'preflight and deployment use one target map')
assert.equal(remote.strategy?.['fail-fast'], false, 'one failed team must not interrupt another team during rollout')
assert.deepEqual(remote.strategy?.matrix.include.map(({ team_id, host, service }) => ({ team_id, host, service })), [
  { team_id: 1, host: '45.154.26.83', service: 'worker-ptwl' },
  { team_id: 2, host: '147.50.240.44', service: 'worker-ifn' },
])
assert.ok(workflow.jobs.deploy.needs?.includes('worker-preflight'))
assert.ok(remote.needs?.includes('deploy'))
assert.match(remote.if ?? '', /refs\/heads\/main/)
for (const [name, job] of Object.entries({ preflight, deploy: workflow.jobs.deploy, remote })) {
  assert.match(job.if ?? '', /github\.event_name != 'pull_request'/,
    `${name} must reject pull_request events to prevent unintended PR deployment`)
}
assert.doesNotMatch(source, /git reset --hard origin\/main/, 'deploy source must match the commit that produced the artifact')
assert.match(source, /git reset --hard "\$\{\{ github\.sha \}\}"/)
assert.match(source, /up -d --force-recreate notifier/)
assert.doesNotMatch(source, /ssh-keyscan/, 'deployment hosts must use pinned host keys')
assert.ok(remote.steps.some((step) => step.run?.includes('ci-deploy-worker.py')))

const primarySteps = workflow.jobs.deploy.steps
const primaryScript = primarySteps.find((step) => step.name === 'Deploy over SSH')?.with?.script ?? ''
const readiness = primaryScript.split('wait_current_readiness() {')[1]?.split('\n}\n')[0] ?? ''
assert.match(readiness, /http:\/\/127\.0\.0\.1:3000\/ready/,
  'primary readiness must verify HTTP and DB readiness')
assert.ok(primaryScript.indexOf('if ! wait_current_readiness; then') < primaryScript.lastIndexOf('rm -f "${ROLLBACK_DIST}"'),
  'the rollback snapshot must survive all primary readiness checks')
assert.equal(primarySteps.some((step) => step.name === 'Verify TEAM 1 lease after primary rollout'), false,
  'worker readiness must not remain as an unprotected post-deployment step')
const stagedHelpers = primarySteps.find((step) => step.name === 'Upload build artifact to server')?.run ?? ''
assert.match(stagedHelpers, /scp[^\n]*scripts\/ci-worker-readiness\.mjs/,
  'the exact checked-out readiness helper must reach primary before deployment')
assert.match(primaryScript, /test -s "\$\{PRIMARY_READINESS_SCRIPT\}"/,
  'a missing readiness helper must fail before replacing primary source or dist')
for (const build of primaryScript.matchAll(/docker compose build([^\n]*)/g)) {
  assert.equal(build[1].replace(/; then$/, '').trim(), 'notifier',
    'primary build and rollback may only rebuild API/notifier')
}
assert.equal((primaryScript.match(/if ! rollback_runtime; then[\s\S]*?fi\n\s+if ! wait_current_readiness; then/g) ?? []).length, 2,
  'both startup failure and readiness failure must verify the restored primary services')
assert.match(primaryScript, /Rollback readiness failed/, 'a failed rollback must be reported explicitly')

const imageExport = primarySteps.find((step) => step.name === 'Export the verified primary image for remote workers')?.run ?? ''
assert.match(imageExport, /trap 'rm -f -- "\$image_archive"' EXIT/,
  'an interrupted image export must remove its partial primary archive')
const primaryCleanup = primarySteps.find((step) => step.name === 'Clean up primary release staging files')
assert.equal(primaryCleanup?.if, 'always()', 'primary image staging must be cleaned after success or failure')
assert.match(primaryCleanup?.run ?? '', /spx-worker-image-\$GITHUB_SHA-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT\.tar\.gz/,
  'cleanup must name only this run and attempt image archive')
assert.doesNotMatch(primaryCleanup?.run ?? '', /rm -[^\n]*\*/, 'cleanup must never glob production files')
const remoteCleanup = remote.steps.find((step) => step.name === 'Clean up worker release archive')
assert.equal(remoteCleanup?.if, 'always()', 'remote archive cleanup must run after success and failed deployment')
assert.match(remoteCleanup?.run ?? '', /\/root\/SPX\/releases\/ci-\$GITHUB_SHA-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT\/image\.tar\.gz/)
assert.doesNotMatch(remoteCleanup?.run ?? '', /rm -[^\n]*\*|rm -rf|manifest\.json/,
  'remote cleanup must preserve manifest, helpers and rollback metadata')

for (const job of [preflight, remote]) {
  const prepare = job.steps.find((step) => step.name === 'Prepare worker SSH')?.run ?? ''
  assert.match(prepare, /"\$WORKER_BOOTSTRAP_SHA" == absent \|\| "\$WORKER_BOOTSTRAP_SHA" =~ \^\[a-fA-F0-9\]\{64\}\$/,
    'each remote job must require a 64-hex checksum or explicit absent sentinel before SSH interpolation')
}
console.log('ci-deploy-workflow: routing, rollback readiness, staging cleanup and checksum safety checks passed')
