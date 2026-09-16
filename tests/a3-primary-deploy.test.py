import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile


MODULE_PATH = Path("scripts/a3-primary-deploy.py").resolve()
SPEC = importlib.util.spec_from_file_location("a3_primary_deploy", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

SOURCE_SHA = "a" * 40
IMAGE_ID = "sha256:" + "b" * 64
BUNDLE_SHA = "c" * 64


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def write_fixture(root):
    release = root / "release"
    (release / "operator" / "deploy").mkdir(parents=True)
    for source, target in (
        (Path("deploy/production-topology.json"), release / "operator" / "deploy" / "production-topology.json"),
        (Path("deploy/production-primary.yml"), release / "operator" / "deploy" / "production-primary.yml"),
        (Path("docker-compose.a3.yml"), release / "operator" / "docker-compose.a3.yml"),
    ):
        target.write_bytes(source.read_bytes())
    manifest = {
        "sourceSha": SOURCE_SHA, "imageId": IMAGE_ID, "imageTag": f"spx-app:{SOURCE_SHA}",
        "operatorBundleSha256": BUNDLE_SHA,
    }
    manifest_bytes = canonical(manifest)
    (release / "release-manifest.json").write_bytes(manifest_bytes)
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    descriptor = {
        "schemaVersion": 1,
        "descriptor": {
            "releaseEnvironment": "production", "runtimeEnvironment": "production",
            "deploymentUnit": "primary", "composeProject": "spx-production", "topology": "split",
            "releaseManifestSha256": manifest_sha, "releaseSourceSha": SOURCE_SHA,
            "imageId": IMAGE_ID, "imageTag": f"spx-app:{SOURCE_SHA}",
            "operatorBundleSha256": BUNDLE_SHA, "publishedPorts": [3000],
            "nodeIds": sorted(MODULE.NODE_IDS.values()),
            "target": {"canonicalPaths": {
                "releaseRoot": "/opt/spx-production/release",
                "environmentFile": "/etc/spx-production/runtime.env",
                "stateRoot": "/var/lib/spx-production-rollout",
            }},
        },
        "descriptorSha256": "d" * 64,
        "signature": {"algorithm": "Ed25519", "keyId": "fixture", "value": "fixture"},
    }
    descriptor_bytes = canonical(descriptor)
    (release / "deployment-target-descriptor.json").write_bytes(descriptor_bytes)
    (release / "spx-image.tar").write_bytes(b"fixture-image")
    descriptor_sha = hashlib.sha256(descriptor_bytes).hexdigest()
    return MODULE.validate_release(release, manifest_sha, descriptor_sha)


class FakeRunner:
    def __init__(self):
        self.commands = []
        self.legacy = {"notifier": "1" * 64, "worker-ptwl": "2" * 64}
        self.candidate = {service: f"{index + 3:x}" * 64 for index, service in enumerate(MODULE.SERVICES)}

    def __call__(self, command, input_text=None, environment=None):
        self.commands.append(command)
        if command[:2] == ["docker", "ps"]:
            project = next(part.rsplit("=", 1)[1] for part in command if "compose.project=" in part)
            service = next(part.rsplit("=", 1)[1] for part in command if "compose.service=" in part)
            if project == MODULE.LEGACY_PROJECT:
                return self.legacy.get(service, "")
            return ""
        if command[:3] == ["docker", "exec", self.legacy["worker-ptwl"]]:
            return "worker\n1\nprod-worker-ptwl-1"
        if command[:2] == ["docker", "load"]:
            return "loaded"
        if command[:3] == ["docker", "image", "inspect"]:
            return IMAGE_ID
        if command[:2] == ["docker", "run"]:
            return '{"schemaVersion":1,"mode":"protected-a3"}'
        if command[0:2] == ["docker", "compose"]:
            if command[-2:] == ["config", "--services"]:
                return "\n".join(MODULE.SERVICES)
            if command[-3:] == ["config", "--format", "json"]:
                services = {name: {"image": f"spx-app:{SOURCE_SHA}", "environment": {}} for name in MODULE.SERVICES}
                services["web-api"]["ports"] = [{"published": "3000", "host_ip": "127.0.0.1"}]
                services["worker-ptwl-split"]["environment"] = {"RUN_TEAM_IDS": "1", "SPX_NODE_ID": MODULE.NODE_IDS["worker-ptwl-split"]}
                return json.dumps({"services": services})
            return ""
        if command[:2] in (["docker", "stop"], ["docker", "start"]):
            return command[-1]
        if command[:2] == ["docker", "inspect"]:
            return "running|healthy|0"
        if command[0] == "curl":
            return "ok"
        raise AssertionError(f"unexpected command: {command}")


def main():
    source = MODULE_PATH.read_text(encoding="utf8")
    assert "down -v" not in source and "volume prune" not in source and "network prune" not in source
    with tempfile.TemporaryDirectory(prefix="spx-primary-deploy-") as temporary:
        root = Path(temporary)
        validated = write_fixture(root)
        environment = root / "runtime.env"
        environment.write_text("fixture=1\n", encoding="utf8")
        state_root = root / "state"
        fake = FakeRunner()
        result = MODULE.install_release(
            validated, state_root, environment, "primary-test-1",
            legacy_line_state=root / "missing-line-state", runner=fake,
            waiter=lambda *_: fake.candidate,
            projection_committer=lambda *_: "/rollback/SPX",
        )
        assert result["state"] == "committed"
        stopped = [command[-1] for command in fake.commands if command[:2] == ["docker", "stop"]]
        assert stopped == [fake.legacy["notifier"], fake.legacy["worker-ptwl"]]
        compose_up = [command for command in fake.commands if command[0:2] == ["docker", "compose"] and "up" in command]
        assert len(compose_up) == 1 and compose_up[0][-len(MODULE.SERVICES):] == list(MODULE.SERVICES)
        assert json.loads((state_root / "state.json").read_text())["state"] == "committed"

        rollback_state = root / "rollback-state"
        context_path = validated["release"] / "deployment-context.json"
        context_path.chmod(0o600)
        context_path.unlink()
        rollback_fake = FakeRunner()
        try:
            MODULE.install_release(
                validated, rollback_state, environment, "primary-test-rollback",
                legacy_line_state=root / "missing-line-state", runner=rollback_fake,
                waiter=lambda *_: (_ for _ in ()).throw(MODULE.DeploymentError("unhealthy")),
                projection_committer=lambda *_: "/rollback/SPX",
            )
            raise AssertionError("failed primary candidate did not roll back")
        except MODULE.DeploymentError as error:
            assert "verified legacy pair was restored" in str(error)
        started = [command[-1] for command in rollback_fake.commands if command[:2] == ["docker", "start"]]
        assert started == [rollback_fake.legacy["notifier"], rollback_fake.legacy["worker-ptwl"]]
        assert json.loads((rollback_state / "state.json").read_text())["state"] == "rolled-back"

        unhealthy_fake = FakeRunner()
        original = unhealthy_fake.__call__
        def unhealthy(command, input_text=None, environment=None):
            if command[:2] == ["docker", "inspect"]:
                return "running|unhealthy|0"
            return original(command, input_text=input_text, environment=environment)
        try:
            MODULE.inspect_legacy(unhealthy)
            raise AssertionError("unhealthy legacy service was accepted")
        except MODULE.DeploymentError as error:
            assert "legacy service is not healthy" in str(error)


if __name__ == "__main__":
    main()
    print("a3 primary deploy tests passed")
