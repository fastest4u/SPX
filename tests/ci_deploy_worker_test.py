import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'ci-deploy-worker.py'
COMMIT = 'a' * 40
OLD_IMAGE = 'sha256:' + '1' * 64
NEW_IMAGE = 'sha256:' + '2' * 64
BUNDLE = '3' * 64


class WorkerDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), 'the remote worker deployment implementation must exist')
        spec = importlib.util.spec_from_file_location('worker_deploy', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.release = self.root / 'releases' / COMMIT
        self.release.mkdir(parents=True)
        (self.root / 'docker-compose.yml').write_text(json.dumps({'services': {'worker-ifn': {
            'image': 'spx-app:old',
            'environment': {'SPX_ROLE': 'worker', 'RUN_TEAM_IDS': '2', 'SPX_NODE_ID': 'prod-worker-ifn-node2'},
        }}}))
        self.before = json.dumps({'services': {'worker-ifn': {
            'image': 'spx-app:old', 'environment': {'NOTIFIER_API_URL': 'https://example.test/events'},
            'volumes': ['./data:/app/data'], 'command': ['node', 'dist/app.js'],
        }}}).encode()
        (self.root / 'docker-compose.override.yml').write_bytes(self.before)
        (self.root / '.env').write_text('fixture-bootstrap-must-remain-untouched')
        (self.release / 'image.tar.gz').write_bytes(b'test image archive')
        self.manifest = dict(commit=COMMIT, imageId=NEW_IMAGE, bundleSha256=BUNDLE,
                             archiveSha256=hashlib.sha256(b'test image archive').hexdigest())
        self.write_manifest()
        self.commands = []
        self.team = '2'
        self.node = 'prod-worker-ifn-node2'
        self.new_running = False
        self.rollback_running = False
        self.fail_new_health = False
        self.fail_new_lease = False
        self.fail_rollback = False
        self.bundle = BUNDLE
        self.configured_team = None
        self.drift_during_load = False

    def compose_model(self, command):
        merged = {}
        for index, value in enumerate(command):
            if value != '-f':
                continue
            text = Path(command[index + 1]).read_text()
            text = '\n'.join(line for line in text.splitlines() if not line.startswith('#'))
            for service, config in json.loads(text)['services'].items():
                current = merged.setdefault(service, {})
                environment = {**current.get('environment', {}), **config.get('environment', {})}
                current.update(config)
                current['environment'] = environment
        return {'services': merged}

    def write_manifest(self):
        (self.release / 'manifest.json').write_text(json.dumps(self.manifest))

    def fake_runner(self, command, input_text=None):
        self.commands.append(command)
        if command[1] == 'compose':
            if 'config' in command:
                if '--format' in command:
                    model = self.compose_model(command)
                    if self.configured_team:
                        model['services']['worker-ifn']['environment']['RUN_TEAM_IDS'] = self.configured_team
                    return json.dumps(model)
                return 'worker-ifn\n'
            if 'ps' in command:
                return 'test-container\n'
            if 'up' in command:
                image = self.compose_model(command)['services']['worker-ifn']['image']
                self.rollback_running = any(value.endswith('compose.rollback.json') for value in command)
                self.new_running = image.startswith('spx-app:ci-') or image == NEW_IMAGE
                if self.fail_rollback and not self.new_running:
                    raise self.module.DeploymentError('simulated rollback failure')
                return ''
        if command[1] == 'inspect':
            template = command[3]
            if template == '{{.Image}}':
                return NEW_IMAGE if self.new_running else OLD_IMAGE
            if template == '{{.Config.Image}}':
                return 'spx-app:ci-test' if self.new_running else 'spx-app:old'
            if template == '{{.State.StartedAt}}':
                return '2026-09-12T01:02:03.123456789Z'
            return 'running|unhealthy|0' if self.new_running and self.fail_new_health and not self.rollback_running else 'running|healthy|0'
        if command[1:3] == ['image', 'inspect']:
            return NEW_IMAGE
        if command[1] == 'exec' and 'printenv' in command:
            return f'worker\n{self.team}\n{self.node}\n'
        if command[1] == 'exec' and 'node' in command:
            return json.dumps({'ready': not (self.new_running and self.fail_new_lease and not self.rollback_running)})
        if command[1] == 'run':
            return self.bundle + '  /app/dist/app.js\n'
        if command[1:3] == ['image', 'load']:
            if self.drift_during_load:
                with (self.root / 'docker-compose.yml').open('a') as stream:
                    stream.write('\n# operator edit during image transfer\n')
            return ''
        if command[1] == 'tag':
            return ''
        raise AssertionError(f'unexpected docker operation: {command}')

    def deploy(self, commit=COMMIT, **extra):
        return self.module.deploy_worker(
            self.root, self.release, 2, 'worker-ifn', 'prod-worker-ifn-node2', commit,
            hashlib.sha256(self.before).hexdigest(), runner=self.fake_runner,
            sleep=lambda _: None, health_attempts=2, **extra)

    def assert_no_restart(self):
        self.assertFalse(any('up' in command for command in self.commands))
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), self.before)

    def test_pins_verified_image_and_preserves_bootstrap(self):
        result = self.deploy()
        self.assertEqual(result['commit'], COMMIT)
        self.assertEqual(result['imageId'], NEW_IMAGE)
        self.assertEqual((self.root / '.env').read_text(), 'fixture-bootstrap-must-remain-untouched')
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), self.before)
        state = json.loads((self.root / '.ci-worker-state.json').read_text())
        self.assertEqual(state['teamId'], 2)
        up = next(command for command in self.commands if 'up' in command)
        for flag in ['--no-deps', '--no-build', '--force-recreate']:
            self.assertIn(flag, up)
        effective = self.compose_model(up)['services']['worker-ifn']
        self.assertEqual(effective['environment']['NOTIFIER_API_URL'], 'https://example.test/events')
        self.assertEqual(effective['environment']['RUN_TEAM_IDS'], '2')
        self.assertEqual(effective['volumes'], ['./data:/app/data'])
        self.assertEqual(effective['command'], ['node', 'dist/app.js'])
        validation = next(command for command in self.commands if '--format' in command and 'config' in command)
        self.assertIn('--no-env-resolution', validation)
        self.assertIn('--no-interpolate', validation)
        ready = next(command for command in self.commands if 'node' in command and '-i' in command)
        self.assertEqual(ready[-1], '2026-09-12T01:02:03.123456789Z')

    def test_rejects_other_team_before_mutation(self):
        self.team = '1'
        with self.assertRaisesRegex(self.module.DeploymentError, 'identity'):
            self.deploy()
        self.assert_no_restart()

    def test_rejects_other_node_before_mutation(self):
        self.node = 'prod-worker-ptwl-1'
        with self.assertRaisesRegex(self.module.DeploymentError, 'identity'):
            self.deploy()
        self.assert_no_restart()

    def test_bad_archive_never_restarts_worker(self):
        (self.release / 'image.tar.gz').write_bytes(b'tampered')
        with self.assertRaisesRegex(self.module.DeploymentError, 'archive'):
            self.deploy()
        self.assert_no_restart()

    def test_wrong_commit_never_restarts_worker(self):
        self.manifest['commit'] = 'b' * 40
        self.write_manifest()
        with self.assertRaisesRegex(self.module.DeploymentError, 'commit'):
            self.deploy()
        self.assert_no_restart()

    def test_wrong_bundle_never_restarts_worker(self):
        self.bundle = '4' * 64
        with self.assertRaisesRegex(self.module.DeploymentError, 'bundle'):
            self.deploy()
        self.assert_no_restart()

    def test_operator_override_edit_is_not_overwritten(self):
        edited = self.before + b'# operator adjustment\n'
        (self.root / 'docker-compose.override.yml').write_bytes(edited)
        with self.assertRaisesRegex(self.module.DeploymentError, 'override'):
            self.deploy()
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), edited)
        self.assertFalse(any('up' in command for command in self.commands))

    def test_rejects_wrong_effective_next_identity_without_restart(self):
        self.configured_team = '1'
        with self.assertRaisesRegex(self.module.DeploymentError, 'identity'):
            self.deploy()
        self.assert_no_restart()

    def test_pins_identity_despite_unapplied_bootstrap_target_change(self):
        base_path = self.root / 'docker-compose.yml'
        changed = json.loads(base_path.read_text())
        changed['services']['worker-ifn']['environment']['RUN_TEAM_IDS'] = '1'
        base_path.write_text(json.dumps(changed))
        self.deploy()
        up = next(command for command in self.commands if 'up' in command)
        self.assertEqual(self.compose_model(up)['services']['worker-ifn']['environment']['RUN_TEAM_IDS'], '2')
        self.assertEqual(json.loads(base_path.read_text()), changed)

    def test_successful_same_release_does_not_restart_again(self):
        before = self.deploy()
        self.commands.clear()
        self.assertEqual(self.deploy(), before)
        self.assert_no_restart()

    def test_managed_overlay_edit_is_not_overwritten(self):
        self.deploy()
        self.commands.clear()
        path = self.root / 'docker-compose.ci-worker.yml'
        edited = path.read_bytes() + b'# operator changed generated config\n'
        path.write_bytes(edited)
        with self.assertRaisesRegex(self.module.DeploymentError, 'configuration'):
            self.deploy()
        self.assertEqual(path.read_bytes(), edited)
        self.assert_no_restart()

    def test_base_drift_after_success_is_rejected(self):
        self.deploy()
        self.commands.clear()
        with (self.root / 'docker-compose.yml').open('a') as stream:
            stream.write('\n# operator changed base configuration\n')
        with self.assertRaisesRegex(self.module.DeploymentError, 'configuration'):
            self.deploy()
        self.assert_no_restart()

    def test_base_drift_during_image_load_is_rejected_before_overlay_mutation(self):
        self.drift_during_load = True
        with self.assertRaisesRegex(self.module.DeploymentError, 'configuration'):
            self.deploy()
        self.assert_no_restart()
        self.assertFalse((self.root / 'docker-compose.ci-worker.yml').exists())

    def test_failed_new_health_restores_exact_previous_override(self):
        self.fail_new_health = True
        with self.assertRaisesRegex(self.module.DeploymentError, 'rolled back'):
            self.deploy()
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), self.before)
        self.assertFalse(self.new_running)
        self.assertFalse((self.root / '.ci-worker-state.json').exists())
        self.assertFalse((self.root / 'docker-compose.ci-worker.yml').exists())

    def test_failed_followup_release_restores_prior_managed_overlay_and_state(self):
        self.deploy()
        overlay = self.root / 'docker-compose.ci-worker.yml'
        state_path = self.root / '.ci-worker-state.json'
        before_overlay, before_state = overlay.read_bytes(), state_path.read_bytes()
        self.manifest['commit'] = 'b' * 40
        self.write_manifest()
        self.fail_new_health = True
        with self.assertRaisesRegex(self.module.DeploymentError, 'rolled back'):
            self.deploy(commit='b' * 40)
        self.assertEqual(overlay.read_bytes(), before_overlay)
        self.assertEqual(state_path.read_bytes(), before_state)
        self.assertEqual((self.root / 'docker-compose.override.yml').read_bytes(), self.before)
        last_up = [command for command in self.commands if 'up' in command][-1]
        self.assertEqual(self.compose_model(last_up)['services']['worker-ifn']['image'], NEW_IMAGE)

    def test_wrong_lease_rolls_back_despite_healthy_process(self):
        self.fail_new_lease = True
        with self.assertRaisesRegex(self.module.DeploymentError, 'rolled back'):
            self.deploy()
        self.assertFalse(self.new_running)

    def test_rollback_failure_is_reported(self):
        self.fail_new_health = True
        self.fail_rollback = True
        with self.assertRaisesRegex(self.module.DeploymentError, 'rollback also failed'):
            self.deploy()

    def test_release_outside_root_is_rejected(self):
        with self.assertRaisesRegex(self.module.DeploymentError, 'release directory'):
            self.module.deploy_worker(self.root, self.root.parent, 2, 'worker-ifn',
                                      self.node, COMMIT, 'absent', runner=self.fake_runner)
        self.assert_no_restart()


if __name__ == '__main__':
    unittest.main()
