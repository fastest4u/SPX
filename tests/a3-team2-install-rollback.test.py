#!/usr/bin/env python3
"""Regression for restoring the current TEAM 2 worker after failed activation."""

import importlib.util
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

print("TEAM 2 failed activation restores the exact legacy worker")
