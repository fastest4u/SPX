#!/usr/bin/env python3
"""Regression for restoring the current TEAM 2 worker after failed activation."""

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace


MODULE_PATH = Path("scripts/a3-team2-deploy.py").resolve()
SPEC = importlib.util.spec_from_file_location("a3_team2_deploy", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeRunner:
    def __init__(self, image_id, image_tag):
        self.commands = []
        self.image_id = image_id
        self.image_tag = image_tag

    def __call__(self, command, input_text=None, environment=None):
        del input_text, environment
        self.commands.append(command)
        if command[-2:] == ["config", "--services"]:
            return MODULE.SERVICE
        if command[-3:] == ["config", "--format", "json"]:
            return json.dumps({
                "services": {
                    MODULE.SERVICE: {
                        "environment": {
                            "RUN_TEAM_IDS": "2",
                            "NOTIFIER_API_URL": "http://127.0.0.1:3000/internal/notification-events",
                            "SPX_NODE_ID": MODULE.NODE_ID,
                            "SPX_ROLE": "worker",
                        },
                        "image": self.image_tag,
                    },
                },
            })
        if command[:4] == ["docker", "image", "inspect", "--format"]:
            return self.image_id
        if command[:5] == ["docker", "run", "--rm", "--network", "none"]:
            return json.dumps({"schemaVersion": 1, "mode": "protected-a3"})
        if command[:4] == ["docker", "ps", "--no-trunc", "-q"]:
            if command[-1] == f"label=com.docker.compose.service={MODULE.SERVICE}":
                return ""
            return "aaaaaaaaaaaa"
        if command[:3] == ["docker", "exec", "aaaaaaaaaaaa"]:
            return f"worker\n2\n{MODULE.NODE_ID}"
        if command[:3] == ["docker", "stop", "-t"]:
            return "aaaaaaaaaaaa"
        if "up" in command:
            raise MODULE.DeploymentError("synthetic activation failure")
        if "rm" in command:
            return ""
        if command == ["docker", "start", "aaaaaaaaaaaa"]:
            return "aaaaaaaaaaaa"
        return ""


with tempfile.TemporaryDirectory(prefix="spx-team2-rollback-") as temporary:
    root = Path(temporary).resolve()
    managed = root / "managed"
    state_root = root / "state"
    release = managed / "releases" / "candidate"
    release.mkdir(parents=True)
    state_root.mkdir()
    environment_file = root / "runtime.env"
    environment_file.write_text("fixture=true\n", encoding="utf8")
    os.chmod(environment_file, 0o600)
    image_id = f"sha256:{'b' * 64}"
    image_tag = f"spx-app:{'a' * 40}"
    validated = {
        "release": release,
        "manifest": {
            "sourceSha": "a" * 40,
            "imageId": image_id,
            "imageTag": image_tag,
            "operatorBundleSha256": "c" * 64,
        },
        "descriptor": {},
        "manifestSha256": "d" * 64,
        "descriptorSha256": "e" * 64,
    }
    runner = FakeRunner(image_id, image_tag)
    original_stat = Path.stat

    def production_stat(path, *args, **kwargs):
        value = original_stat(path, *args, **kwargs)
        if Path(path) == environment_file:
            return SimpleNamespace(st_mode=(value.st_mode & ~0o777) | 0o600, st_uid=0)
        return value

    Path.stat = production_stat
    try:
        MODULE.install_release(
            validated,
            managed,
            state_root,
            environment_file,
            "rollback-regression",
            runner=runner,
            tunnel_probe=lambda: None,
        )
        raise AssertionError("failed candidate activation unexpectedly succeeded")
    except MODULE.DeploymentError as error:
        assert str(error) == "TEAM 2 deployment failed and the verified prior worker was restored"
    finally:
        Path.stat = original_stat

    stop_index = runner.commands.index(["docker", "stop", "-t", "120", "aaaaaaaaaaaa"])
    start_index = runner.commands.index(["docker", "start", "aaaaaaaaaaaa"])
    up_index = next(index for index, command in enumerate(runner.commands) if "up" in command)
    remove_index = next(index for index, command in enumerate(runner.commands) if "rm" in command)
    assert stop_index < up_index < remove_index < start_index
    assert not (state_root / "state.json").exists()


class DuplicateInventoryRunner:
    def __call__(self, command, input_text=None, environment=None):
        del input_text, environment
        if command[-1] == f"label=com.docker.compose.service={MODULE.SERVICE}":
            return "bbbbbbbbbbbb\ncccccccccccc"
        if command[-1] == f"label=com.docker.compose.service={MODULE.LEGACY_SERVICE}":
            return ""
        raise AssertionError(f"unexpected inventory command: {command}")


try:
    MODULE.resolve_previous_worker(None, DuplicateInventoryRunner())
    raise AssertionError("duplicate protected workers were accepted")
except MODULE.DeploymentError as error:
    assert str(error) == "TEAM 2 preflight found duplicate active pollers"


class ProtectedRollbackRunner:
    def __init__(self, image_id, image_tag):
        self.commands = []
        self.image_id = image_id
        self.image_tag = image_tag
        self.up_calls = 0

    def __call__(self, command, input_text=None, environment=None):
        del input_text, environment
        self.commands.append(command)
        if command[-2:] == ["config", "--services"]:
            return MODULE.SERVICE
        if command[-3:] == ["config", "--format", "json"]:
            return json.dumps({
                "services": {
                    MODULE.SERVICE: {
                        "environment": {
                            "RUN_TEAM_IDS": "2",
                            "NOTIFIER_API_URL": "http://127.0.0.1:3000/internal/notification-events",
                            "SPX_NODE_ID": MODULE.NODE_ID,
                            "SPX_ROLE": "worker",
                        },
                        "image": self.image_tag,
                    },
                },
            })
        if command[:4] == ["docker", "image", "inspect", "--format"]:
            return self.image_id
        if command[:5] == ["docker", "run", "--rm", "--network", "none"]:
            return json.dumps({"schemaVersion": 1, "mode": "protected-a3"})
        if command[:4] == ["docker", "ps", "--no-trunc", "-q"]:
            if command[-1] == f"label=com.docker.compose.service={MODULE.SERVICE}":
                return "bbbbbbbbbbbb"
            return ""
        if " up " in f" {' '.join(command)} ":
            self.up_calls += 1
            if self.up_calls == 1:
                raise MODULE.DeploymentError("synthetic candidate activation failure")
            return ""
        if " ps " in f" {' '.join(command)} " and command[-2:] == ["-q", MODULE.SERVICE]:
            return "cccccccccccc"
        if command[:3] == ["docker", "inspect", "--format"]:
            template = command[3]
            if ".State.Status" in template:
                return "running|healthy|0"
            if template == "{{.Image}}":
                return self.image_id
            if template == "{{.State.StartedAt}}":
                return "2026-09-15T05:00:00.000000000Z"
        if command[:3] == ["docker", "exec", "cccccccccccc"]:
            if command[3:5] == ["printenv", "SPX_ROLE"]:
                return f"worker\n2\n{MODULE.NODE_ID}"
        if command[:4] == ["docker", "exec", "-i", "cccccccccccc"]:
            return json.dumps({"ready": True})
        if "stop" in command or "rm" in command:
            return ""
        return ""


with tempfile.TemporaryDirectory(prefix="spx-team2-protected-rollback-") as temporary:
    root = Path(temporary).resolve()
    managed = root / "managed"
    state_root = root / "state"
    release = managed / "releases" / "candidate"
    (release / "operator" / "deploy").mkdir(parents=True)
    (release / "operator" / "scripts").mkdir(parents=True)
    state_root.mkdir()
    environment_file = root / "runtime.env"
    environment_file.write_text("fixture=true\n", encoding="utf8")
    os.chmod(environment_file, 0o600)
    source_sha = "a" * 40
    image_id = f"sha256:{'b' * 64}"
    image_tag = f"spx-app:{source_sha}"
    manifest = {
        "imageId": image_id,
        "imageTag": image_tag,
        "operatorBundleSha256": "c" * 64,
        "sourceSha": source_sha,
    }
    manifest_bytes = MODULE.canonical_json(manifest).encode()
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    descriptor = {
        "schemaVersion": 1,
        "descriptor": {
            "composeProject": MODULE.PROJECT,
            "database": {"accountHosts": {MODULE.SERVICE: "172.17.0.1"}},
            "deploymentUnit": "team2",
            "imageId": image_id,
            "imageTag": image_tag,
            "nodeIds": [MODULE.NODE_ID],
            "operatorBundleSha256": "c" * 64,
            "publishedPorts": [],
            "releaseEnvironment": "production",
            "releaseManifestSha256": manifest_sha,
            "releaseSourceSha": source_sha,
            "runtimeEnvironment": "production",
            "target": {"canonicalPaths": {
                "releaseRoot": "/opt/spx-production-team2",
                "environmentFile": "/etc/spx-production/runtime.env",
                "stateRoot": "/var/lib/spx-production-team2-rollout",
            }},
            "topology": "split",
        },
        "descriptorSha256": "d" * 64,
        "signature": {"algorithm": "Ed25519", "keyId": "test", "value": "e" * 86},
    }
    descriptor_bytes = MODULE.canonical_json(descriptor).encode()
    descriptor_sha = hashlib.sha256(descriptor_bytes).hexdigest()
    (release / "release-manifest.json").write_bytes(manifest_bytes)
    (release / "deployment-target-descriptor.json").write_bytes(descriptor_bytes)
    (release / "spx-image.tar").write_text("fixture-image", encoding="utf8")
    (release / "operator" / "deploy" / "production-team2.yml").write_text("services: {}\n", encoding="utf8")
    (release / "operator" / "scripts" / "a3-team2-readiness.mjs").write_text("fixture", encoding="utf8")
    topology = {
        "topology": "split-two-host",
        "deploymentOrder": ["primary", "team2"],
        "units": [{}, {
            "id": "team2", "host": MODULE.HOST, "composeProject": MODULE.PROJECT,
            "composeFiles": ["deploy/production-team2.yml"],
            "services": [{"name": MODULE.SERVICE, "role": "worker", "teamIds": [2], "nodeId": MODULE.NODE_ID}],
            "publishedPorts": [], "runsMigrations": False,
        }],
    }
    (release / "operator" / "deploy" / "production-topology.json").write_text(json.dumps(topology), encoding="utf8")
    previous_state = {
        "schemaVersion": 1, "deploymentUnit": "team2", "service": MODULE.SERVICE,
        "teamId": 2, "nodeId": MODULE.NODE_ID, "releaseDir": str(release),
        "sourceSha": source_sha, "imageId": image_id,
        "releaseManifestSha256": manifest_sha, "targetDescriptorSha256": descriptor_sha,
        "containerId": "bbbbbbbbbbbb",
    }
    (state_root / "state.json").write_text(MODULE.canonical_json(previous_state), encoding="utf8")
    validated = {
        "release": release, "manifest": manifest, "descriptor": descriptor["descriptor"],
        "manifestSha256": manifest_sha, "descriptorSha256": descriptor_sha,
    }
    runner = ProtectedRollbackRunner(image_id, image_tag)
    linked_releases = []
    original_stat = Path.stat

    def protected_production_stat(path, *args, **kwargs):
        value = original_stat(path, *args, **kwargs)
        if Path(path) == environment_file:
            return SimpleNamespace(st_mode=(value.st_mode & ~0o777) | 0o600, st_uid=0)
        return value

    Path.stat = protected_production_stat
    try:
        MODULE.install_release(
            validated, managed, state_root, environment_file, "protected-rollback-regression",
            runner=runner, tunnel_probe=lambda: None,
            linker=lambda _managed, linked: linked_releases.append(Path(linked)),
        )
        raise AssertionError("failed protected activation unexpectedly succeeded")
    except MODULE.DeploymentError as error:
        assert str(error) == "TEAM 2 deployment failed and the verified prior worker was restored"
    finally:
        Path.stat = original_stat

    restored_state = json.loads((state_root / "state.json").read_text(encoding="utf8"))
    assert restored_state["containerId"] == "cccccccccccc"
    assert linked_releases == [release]


print("TEAM 2 failed activation restores legacy and protected managed state")
