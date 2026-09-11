#!/usr/bin/env python3
"""Deploy one existing dedicated worker from a verified CI image, without reading .env."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

CI_OVERLAY = 'docker-compose.ci-worker.yml'
CONFIGURATION_FILES = ('docker-compose.yml', 'docker-compose.override.yml', CI_OVERLAY)


class DeploymentError(RuntimeError):
    pass


def run_command(command, input_text=None):
    result = subprocess.run(command, input=input_text, text=True, capture_output=True, timeout=180)
    if result.returncode:
        # Never forward arbitrary Docker/provider output or expanded environment values.
        raise DeploymentError(f'{command[0]} {command[1]} failed with exit {result.returncode}')
    return result.stdout.strip()


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def atomic_write(path, data):
    temporary = path.with_name(f'.{path.name}.tmp-{os.getpid()}')
    try:
        with temporary.open('xb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def configuration_hashes(root):
    result = {}
    for name in CONFIGURATION_FILES:
        path = root / name
        if path.is_symlink():
            raise DeploymentError('deployment configuration cannot be a symlink')
        result[name] = digest(path) if path.exists() else 'absent'
    return result


def require_unchanged_configuration(root, expected):
    if configuration_hashes(root) != expected:
        raise DeploymentError('worker configuration changed during deployment')


def compose(root, overlay=None):
    command = ['docker', 'compose', '--project-directory', str(root), '-f', str(root / 'docker-compose.yml')]
    if (root / 'docker-compose.override.yml').exists():
        command += ['-f', str(root / 'docker-compose.override.yml')]
    selected = overlay if overlay is not None else root / CI_OVERLAY
    if selected.exists():
        command += ['-f', str(selected)]
    return command


def validate_next_identity(root, overlay, service, team_id, node_id, runner):
    # Do not resolve env_file or interpolate bootstrap secrets. The CI overlay
    # pins these three literal values, so no other environment data is needed.
    model = json.loads(runner(compose(root, overlay) + [
        'config', '--format', 'json', '--no-env-resolution', '--no-interpolate',
    ]))
    services = model.get('services', {})
    environment = services.get(service, {}).get('environment', {})
    expected = {'SPX_ROLE': 'worker', 'RUN_TEAM_IDS': str(team_id), 'SPX_NODE_ID': node_id}
    if set(services) != {service} or any(environment.get(key) != value for key, value in expected.items()):
        raise DeploymentError('next worker identity does not match the designated team/node')


def overlay_contents(service, team_id, node_id, image, commit):
    generated = {'services': {service: {
        'image': image, 'stop_grace_period': '120s',
        'environment': {'SPX_ROLE': 'worker', 'RUN_TEAM_IDS': str(team_id), 'SPX_NODE_ID': node_id},
        'labels': {'com.spx.release.commit': commit},
        'healthcheck': {'test': ['CMD-SHELL', "ps | grep -q '[n]ode dist/app.js'"],
                        'interval': '30s', 'timeout': '5s', 'retries': 3, 'start_period': '20s'},
    }}}
    return ('# Managed by SPX CI worker deployment\n' + json.dumps(generated, indent=2) + '\n').encode()


def validate_identity(container, team_id, node_id, runner):
    actual = runner(['docker', 'exec', container, 'printenv', 'SPX_ROLE', 'RUN_TEAM_IDS', 'SPX_NODE_ID'])
    if actual.strip().splitlines() != ['worker', str(team_id), node_id]:
        raise DeploymentError('worker identity does not match the designated team/node')


def preflight(root, team_id, service, node_id, bootstrap_sha, runner=run_command):
    root = Path(root).resolve()
    if team_id < 1 or not re.fullmatch(r'worker-[a-z0-9-]+', service) or not re.fullmatch(r'[A-Za-z0-9_-]+', node_id):
        raise DeploymentError('invalid worker identity arguments')
    override = root / 'docker-compose.override.yml'
    state_path = root / '.ci-worker-state.json'
    for path in (override, state_path, root / 'docker-compose.yml'):
        if path.is_symlink():
            raise DeploymentError('deployment configuration cannot be a symlink')
    if not (root / 'docker-compose.yml').is_file():
        raise DeploymentError('existing worker compose file is required')
    fingerprints = configuration_hashes(root)
    actual_sha = fingerprints['docker-compose.override.yml']
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    expected_sha = state['overrideSha256'] if state else bootstrap_sha
    if state and (state.get('teamId') != team_id or state.get('nodeId') != node_id or state.get('service') != service):
        raise DeploymentError('saved worker identity differs from this target')
    if actual_sha != expected_sha:
        raise DeploymentError('worker override changed; refusing to overwrite operator configuration')
    if state and state.get('configurationSha256') != fingerprints:
        raise DeploymentError('saved worker configuration changed; operator review required')
    if not state and fingerprints[CI_OVERLAY] != 'absent':
        raise DeploymentError('untracked CI worker configuration requires operator review')
    services = runner(compose(root) + ['config', '--services', '--no-env-resolution', '--no-interpolate']).strip().splitlines()
    if services != [service]:
        raise DeploymentError('remote deployment requires a dedicated one-worker Compose project')
    container = runner(compose(root) + ['ps', '-q', service]).strip()
    if not container or '\n' in container:
        raise DeploymentError('exactly one existing running worker is required')
    validate_identity(container, team_id, node_id, runner)
    previous_image = runner(['docker', 'inspect', '--format', '{{.Image}}', container]).strip()
    previous_tag = runner(['docker', 'inspect', '--format', '{{.Config.Image}}', container]).strip()
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', previous_image):
        raise DeploymentError('invalid current worker image identity')
    require_unchanged_configuration(root, fingerprints)
    return container, previous_image, previous_tag, state, fingerprints


def wait_ready(root, service, team_id, node_id, expected_image, runner, sleep, attempts):
    readiness = Path(__file__).with_name('ci-worker-readiness.mjs').read_text()
    for attempt in range(attempts):
        try:
            container = runner(compose(root) + ['ps', '-q', service]).strip()
            state = runner(['docker', 'inspect', '--format',
                            '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}',
                            container]).strip()
            image = runner(['docker', 'inspect', '--format', '{{.Image}}', container]).strip()
            if state == 'running|healthy|0' and image == expected_image:
                validate_identity(container, team_id, node_id, runner)
                started_at = runner(['docker', 'inspect', '--format', '{{.State.StartedAt}}', container]).strip()
                result = runner(['docker', 'exec', '-i', container, 'node', '--input-type=module', '-',
                                 str(team_id), node_id, started_at], input_text=readiness)
                if json.loads(result).get('ready') is True:
                    return
        except (DeploymentError, ValueError):
            pass
        if attempt + 1 < attempts:
            sleep(3)
    raise DeploymentError('worker failed image/health/lease readiness')


def deploy_worker(root, release_dir, team_id, service, node_id, expected_commit, bootstrap_sha,
                  runner=run_command, sleep=time.sleep, health_attempts=30):
    root, release = Path(root).resolve(), Path(release_dir).resolve()
    if not release.is_relative_to(root / 'releases') or release == root / 'releases':
        raise DeploymentError('release directory must be below the worker releases directory')
    for filename in ('manifest.json', 'image.tar.gz'):
        if (release / filename).is_symlink():
            raise DeploymentError('release files cannot be symlinks')
    manifest = json.loads((release / 'manifest.json').read_text())
    if not re.fullmatch(r'[a-f0-9]{40}', expected_commit) or manifest.get('commit') != expected_commit:
        raise DeploymentError('release commit does not match this workflow')
    image_id = manifest.get('imageId', '')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id):
        raise DeploymentError('invalid release image identity')
    for key in ('bundleSha256', 'archiveSha256'):
        if not re.fullmatch(r'[a-f0-9]{64}', manifest.get(key, '')):
            raise DeploymentError('invalid release checksum')
    if digest(release / 'image.tar.gz') != manifest['archiveSha256']:
        raise DeploymentError('image archive checksum mismatch')
    _, previous_image, previous_tag, previous_state, fingerprints = preflight(
        root, team_id, service, node_id, bootstrap_sha, runner)
    if previous_state and previous_state.get('commit') == expected_commit and previous_image == image_id:
        wait_ready(root, service, team_id, node_id, image_id, runner, sleep, health_attempts)
        return previous_state

    runner(['docker', 'image', 'load', '-i', str(release / 'image.tar.gz')])
    loaded = runner(['docker', 'image', 'inspect', '--format', '{{.Id}}', image_id]).strip()
    if loaded != image_id:
        raise DeploymentError('loaded image identity mismatch')
    bundle = runner(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum',
                     image_id, '/app/dist/app.js']).split()
    if not bundle or bundle[0] != manifest['bundleSha256']:
        raise DeploymentError('loaded image bundle checksum mismatch')
    tag = f'spx-app:ci-{expected_commit}-{image_id[7:19]}'
    runner(['docker', 'tag', image_id, tag])
    runner(['docker', 'tag', previous_image, f'spx-app:rollback-team-{team_id}-{expected_commit}'])
    overlay = root / CI_OVERLAY
    before = overlay.read_bytes() if overlay.exists() else None
    if before is not None:
        atomic_write(release / 'ci-overlay.before.yml', before)
    contents = overlay_contents(service, team_id, node_id, tag, expected_commit)
    candidate = release / 'compose.candidate.json'
    atomic_write(candidate, contents)
    validate_next_identity(root, candidate, service, team_id, node_id, runner)
    # Image loading and candidate validation can take minutes. Check again at
    # the mutation boundary so an intervening operator edit is never adopted.
    require_unchanged_configuration(root, fingerprints)
    deployed_fingerprints = {**fingerprints, CI_OVERLAY: hashlib.sha256(contents).hexdigest()}
    restart = ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', '-t', '120', service]
    installed = False
    try:
        atomic_write(overlay, contents)
        installed = True
        require_unchanged_configuration(root, deployed_fingerprints)
        runner(compose(root) + restart)
        wait_ready(root, service, team_id, node_id, image_id, runner, sleep, health_attempts)
        require_unchanged_configuration(root, deployed_fingerprints)
        state = {**manifest, 'teamId': team_id, 'nodeId': node_id, 'service': service,
                 'overrideSha256': fingerprints['docker-compose.override.yml'],
                 'configurationSha256': deployed_fingerprints, 'previousImageId': previous_image}
        atomic_write(root / '.ci-worker-state.json', (json.dumps(state, indent=2) + '\n').encode())
        return state
    except Exception as failure:
        if not installed:
            raise DeploymentError('deployment configuration could not be installed; worker was not restarted') from failure
        try:
            require_unchanged_configuration(root, deployed_fingerprints)
            if before is None:
                overlay.unlink(missing_ok=True)
            else:
                atomic_write(overlay, before)
            if not previous_tag.startswith('sha256:') and '@' not in previous_tag:
                runner(['docker', 'tag', previous_image, previous_tag])
            rollback = release / 'compose.rollback.json'
            atomic_write(rollback, overlay_contents(service, team_id, node_id, previous_image,
                                                    previous_state.get('commit', 'rollback') if previous_state else 'rollback'))
            validate_next_identity(root, rollback, service, team_id, node_id, runner)
            require_unchanged_configuration(root, fingerprints)
            runner(compose(root, rollback) + restart)
            wait_ready(root, service, team_id, node_id, previous_image, runner, sleep, health_attempts)
        except Exception as rollback_failure:
            raise DeploymentError('deployment failed and rollback also failed; operator attention required') from rollback_failure
        raise DeploymentError('deployment failed; rolled back to the verified previous worker') from failure


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('/root/SPX'))
    parser.add_argument('--release-dir', type=Path)
    parser.add_argument('--team-id', type=int, required=True)
    parser.add_argument('--service', required=True)
    parser.add_argument('--node-id', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--bootstrap-override-sha256', required=True)
    parser.add_argument('--preflight-only', action='store_true')
    args = parser.parse_args()
    # Linux deployment hosts serialize manual invocations as well as CI jobs.
    import fcntl
    with (args.root / '.ci-worker-deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.preflight_only:
            preflight(args.root, args.team_id, args.service, args.node_id, args.bootstrap_override_sha256)
            print(json.dumps({'ready': True, 'teamId': args.team_id, 'nodeId': args.node_id}))
        else:
            if args.release_dir is None:
                parser.error('--release-dir is required for deployment')
            result = deploy_worker(args.root, args.release_dir, args.team_id, args.service,
                                   args.node_id, args.commit, args.bootstrap_override_sha256)
            print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Domain errors are fixed strings; arbitrary third-party exceptions stay private.
        print(json.dumps({'deployed': False, 'error': str(error) if isinstance(error, DeploymentError)
                          else 'deployment preflight or operation failed'}))
        raise SystemExit(1)
