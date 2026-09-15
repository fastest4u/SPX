#!/usr/bin/env python3
"""Validate, install, and roll back the isolated protected A3 TEAM 2 worker."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time

SERVICE = "worker-ifn-split"
LEGACY_SERVICE = "worker-ifn"
TEAM_ID = 2
NODE_ID = "prod-worker-ifn-node2"
HOST = "147.50.240.44"
PROJECT = "spx-production"
SHA256 = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}$")


class DeploymentError(RuntimeError):
    pass


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def safe_json(path, label):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise DeploymentError(f"{label} is not a safe regular file")
    raw = path.read_bytes()
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DeploymentError(f"{label} is not valid JSON") from error
    if raw != canonical_json(value).encode():
        raise DeploymentError(f"{label} is not canonical JSON")
    return value


def atomic_write(path, data, mode=0o400):
    path = Path(path)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.new")
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def run_command(command, input_text=None, environment=None):
    result = subprocess.run(
        command,
        input=input_text,
        text=True,
        capture_output=True,
        timeout=240,
        env=environment,
    )
    if result.returncode:
        raise DeploymentError(f"{command[0]} operation failed with exit {result.returncode}")
    return result.stdout.strip()


def validate_release(release_dir, release_manifest_sha256, target_descriptor_sha256):
    release = Path(release_dir).resolve()
    required = {
        "manifest": release / "release-manifest.json",
        "descriptor": release / "deployment-target-descriptor.json",
        "topology": release / "operator" / "deploy" / "production-topology.json",
        "compose": release / "operator" / "deploy" / "production-team2.yml",
        "image": release / "spx-image.tar",
        "readiness": release / "operator" / "scripts" / "a3-team2-readiness.mjs",
    }
    for label, path in required.items():
        if path.is_symlink() or not path.is_file():
            raise DeploymentError(f"TEAM 2 {label} file is missing or unsafe")
    if not SHA256.fullmatch(release_manifest_sha256) or digest(required["manifest"]) != release_manifest_sha256:
        raise DeploymentError("TEAM 2 release manifest digest mismatch")
    if not SHA256.fullmatch(target_descriptor_sha256) or digest(required["descriptor"]) != target_descriptor_sha256:
        raise DeploymentError("TEAM 2 target descriptor digest mismatch")

    manifest = safe_json(required["manifest"], "release manifest")
    source_sha = manifest.get("sourceSha", "")
    image_id = manifest.get("imageId", "")
    image_tag = manifest.get("imageTag", "")
    bundle_sha = manifest.get("operatorBundleSha256", "")
    if not SOURCE_SHA.fullmatch(source_sha) or not IMAGE_ID.fullmatch(image_id):
        raise DeploymentError("TEAM 2 release identity is invalid")
    if image_tag != f"spx-app:{source_sha}" or not SHA256.fullmatch(bundle_sha):
        raise DeploymentError("TEAM 2 release tuple is invalid")

    signed = safe_json(required["descriptor"], "target descriptor")
    descriptor = signed.get("descriptor") if isinstance(signed, dict) else None
    signature = signed.get("signature") if isinstance(signed, dict) else None
    if not isinstance(descriptor, dict) or not isinstance(signature, dict):
        raise DeploymentError("TEAM 2 target descriptor is malformed")
    if signed.get("schemaVersion") != 1 or signature.get("algorithm") != "Ed25519":
        raise DeploymentError("TEAM 2 target descriptor signature metadata is invalid")
    expected = {
        "releaseEnvironment": "production",
        "runtimeEnvironment": "production",
        "deploymentUnit": "team2",
        "composeProject": PROJECT,
        "topology": "split",
        "releaseManifestSha256": release_manifest_sha256,
        "releaseSourceSha": source_sha,
        "imageId": image_id,
        "imageTag": image_tag,
        "operatorBundleSha256": bundle_sha,
    }
    if any(descriptor.get(key) != value for key, value in expected.items()):
        raise DeploymentError("TEAM 2 target descriptor does not match the immutable release")
    if descriptor.get("publishedPorts") != [] or descriptor.get("nodeIds") != [NODE_ID]:
        raise DeploymentError("TEAM 2 target descriptor exposes ports or has the wrong node")
    if descriptor.get("database", {}).get("accountHosts", {}).keys() != {SERVICE}:
        raise DeploymentError("TEAM 2 target descriptor has the wrong database principal set")
    canonical_paths = descriptor.get("target", {}).get("canonicalPaths", {})
    if canonical_paths != {
        "releaseRoot": "/opt/spx-production-team2",
        "environmentFile": "/etc/spx-production/runtime.env",
        "stateRoot": "/var/lib/spx-production-team2-rollout",
    }:
        raise DeploymentError("TEAM 2 target descriptor canonical paths are invalid")

    topology = json.loads(required["topology"].read_text(encoding="utf8"))
    if topology.get("topology") != "split-two-host" or topology.get("deploymentOrder") != ["primary", "team2"]:
        raise DeploymentError("TEAM 2 production topology is invalid")
    units = topology.get("units")
    unit = units[1] if isinstance(units, list) and len(units) == 2 else None
    if not isinstance(unit, dict) or unit.get("id") != "team2" or unit.get("host") != HOST:
        raise DeploymentError("TEAM 2 production topology target is invalid")
    if unit.get("composeProject") != PROJECT or unit.get("composeFiles") != ["deploy/production-team2.yml"]:
        raise DeploymentError("TEAM 2 production topology Compose projection is invalid")
    services = unit.get("services")
    if not isinstance(services, list) or len(services) != 1:
        raise DeploymentError("TEAM 2 production topology must contain one worker")
    service = services[0]
    if service.get("name") != SERVICE or service.get("role") != "worker" or service.get("teamIds") != [TEAM_ID] or service.get("nodeId") != NODE_ID:
        raise DeploymentError("TEAM 2 production topology worker identity is invalid")
    if unit.get("publishedPorts") != [] or unit.get("runsMigrations") is not False:
        raise DeploymentError("TEAM 2 production topology privileges are invalid")
    return {
        "release": release,
        "manifest": manifest,
        "descriptor": descriptor,
        "manifestSha256": release_manifest_sha256,
        "descriptorSha256": target_descriptor_sha256,
    }


def runtime_context(validated, operation_id):
    manifest = validated["manifest"]
    return {
        "schemaVersion": 1,
        "operationId": operation_id,
        "target": "production",
        "deploymentUnit": "team2",
        "sourceSha": manifest["sourceSha"],
        "imageId": manifest["imageId"],
        "imageTag": manifest["imageTag"],
        "topology": "split",
        "composeProject": PROJECT,
        "releaseManifestSha256": validated["manifestSha256"],
        "operatorBundleSha256": manifest["operatorBundleSha256"],
        "descriptorArtifactSha256": validated["descriptorSha256"],
    }


def compose(validated, environment_file):
    release = validated["release"]
    return [
        "docker", "compose", "-p", PROJECT, "--env-file", str(environment_file),
        "-f", str(release / "operator" / "deploy" / "production-team2.yml"),
    ]


def compose_environment(validated):
    release = validated["release"]
    manifest = validated["manifest"]
    return {
        **os.environ,
        "SPX_IMAGE": manifest["imageTag"],
        "SPX_RELEASE_SHA": manifest["sourceSha"],
        "SPX_TARGET_DESCRIPTOR_SHA256": validated["descriptorSha256"],
        "SPX_OPERATOR_BUNDLE_SHA256": manifest["operatorBundleSha256"],
        "SPX_RELEASE_MANIFEST_PATH": str(release / "release-manifest.json"),
        "SPX_TARGET_DESCRIPTOR_PATH": str(release / "deployment-target-descriptor.json"),
        "SPX_DEPLOYMENT_CONTEXT_PATH": str(release / "deployment-context.json"),
    }


def validate_compose(validated, environment_file, runner=run_command):
    command = compose(validated, environment_file)
    environment = compose_environment(validated)
    services = runner(command + ["--profile", "split", "config", "--services"], environment=environment).splitlines()
    if services != [SERVICE]:
        raise DeploymentError("TEAM 2 Compose projection must contain exactly one worker")
    model = json.loads(runner(command + ["--profile", "split", "config", "--format", "json"], environment=environment))
    service = model.get("services", {}).get(SERVICE, {})
    identity = service.get("environment", {})
    if service.get("image") != validated["manifest"]["imageTag"]:
        raise DeploymentError("TEAM 2 Compose image is not the immutable release")
    if any(str(identity.get(key)) != value for key, value in {"SPX_ROLE": "worker", "RUN_TEAM_IDS": "2", "SPX_NODE_ID": NODE_ID}.items()):
        raise DeploymentError("TEAM 2 Compose identity is invalid")
    if identity.get("NOTIFIER_API_URL") != "http://127.0.0.1:3000/internal/notification-events":
        raise DeploymentError("TEAM 2 Compose notification route is invalid")
    if service.get("ports") or service.get("expose"):
        raise DeploymentError("TEAM 2 Compose must not publish ports")


def validate_container(container, expected_image, runner=run_command):
    if not re.fullmatch(r"[0-9a-f]{12,64}", container):
        raise DeploymentError("TEAM 2 container identity is invalid")
    image = runner(["docker", "inspect", "--format", "{{.Image}}", container])
    if image != expected_image:
        raise DeploymentError("TEAM 2 container image is invalid")
    identity = runner(["docker", "exec", container, "printenv", "SPX_ROLE", "RUN_TEAM_IDS", "SPX_NODE_ID"]).splitlines()
    if identity != ["worker", "2", NODE_ID]:
        raise DeploymentError("TEAM 2 container role/team/node identity is invalid")


def active_service_containers(service, runner=run_command):
    containers = runner([
        "docker", "ps", "--no-trunc", "-q", "--filter", f"label=com.docker.compose.service={service}",
    ]).splitlines()
    if len(containers) != len(set(containers)) or any(
        not re.fullmatch(r"[0-9a-f]{12,64}", container) for container in containers
    ):
        raise DeploymentError("TEAM 2 active container inventory is invalid")
    return containers


def resolve_previous_worker(previous_state, runner=run_command):
    protected = active_service_containers(SERVICE, runner)
    legacy = active_service_containers(LEGACY_SERVICE, runner)
    if len(protected) > 1 or len(legacy) > 1 or (protected and legacy):
        raise DeploymentError("TEAM 2 preflight found duplicate active pollers")
    if previous_state:
        expected = previous_state.get("containerId")
        if not isinstance(expected, str) or protected != [expected]:
            raise DeploymentError("TEAM 2 protected worker does not match managed state")
        return {"kind": "protected", "container": expected}
    if protected:
        raise DeploymentError("TEAM 2 found an unmanaged protected worker")
    if len(legacy) != 1:
        raise DeploymentError("TEAM 2 adoption requires exactly one current worker")
    return {"kind": "legacy", "container": legacy[0]}


def verify_notification_tunnel():
    try:
        with socket.create_connection(("127.0.0.1", 3000), timeout=5):
            return
    except OSError as error:
        raise DeploymentError("TEAM 2 private notification tunnel is unavailable") from error


def wait_ready(validated, environment_file, runner=run_command, sleep=time.sleep, attempts=40):
    readiness = (validated["release"] / "operator" / "scripts" / "a3-team2-readiness.mjs").read_text(encoding="utf8")
    command = compose(validated, environment_file)
    environment = compose_environment(validated)
    for attempt in range(attempts):
        try:
            container = runner(command + ["--profile", "split", "ps", "-q", SERVICE], environment=environment)
            state = runner(["docker", "inspect", "--format", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}", container])
            if state != "running|healthy|0":
                raise DeploymentError("TEAM 2 worker is not healthy")
            validate_container(container, validated["manifest"]["imageId"], runner)
            started = runner(["docker", "inspect", "--format", "{{.State.StartedAt}}", container])
            result = runner(["docker", "exec", "-i", container, "node", "--input-type=module", "-", "2", NODE_ID, started], input_text=readiness)
            if json.loads(result).get("ready") is True:
                return container
        except (DeploymentError, ValueError, json.JSONDecodeError):
            pass
        if attempt + 1 < attempts:
            sleep(3)
    raise DeploymentError("TEAM 2 worker failed image/health/lease readiness")


def install_release(
    validated,
    managed_root,
    state_root,
    environment_file,
    operation_id,
    runner=run_command,
    tunnel_probe=verify_notification_tunnel,
):
    managed_root = Path(managed_root).resolve()
    state_root = Path(state_root).resolve()
    environment_file = Path(environment_file)
    if validated["release"].parent != managed_root / "releases":
        raise DeploymentError("TEAM 2 release is outside the managed release root")
    if environment_file.is_symlink() or not environment_file.is_file():
        raise DeploymentError("TEAM 2 protected environment file is missing or unsafe")
    mode = environment_file.stat().st_mode & 0o777
    if environment_file.stat().st_uid != 0 or mode not in (0o400, 0o440, 0o600, 0o640):
        raise DeploymentError("TEAM 2 protected environment file ownership or mode is invalid")
    tunnel_probe()
    context_path = validated["release"] / "deployment-context.json"
    context_bytes = canonical_json(runtime_context(validated, operation_id)).encode()
    if context_path.exists():
        if context_path.is_symlink() or context_path.read_bytes() != context_bytes:
            raise DeploymentError("TEAM 2 deployment context does not match this operation")
    else:
        atomic_write(context_path, context_bytes, 0o444)

    runner(["docker", "load", "--input", str(validated["release"] / "spx-image.tar")])
    image_id = validated["manifest"]["imageId"]
    image_tag = validated["manifest"]["imageTag"]
    if runner(["docker", "image", "inspect", "--format", "{{.Id}}", image_tag]) != image_id:
        raise DeploymentError("TEAM 2 loaded image identity mismatch")
    contract = json.loads(runner(["docker", "run", "--rm", "--network", "none", "--entrypoint", "cat", image_id, "/app/dist/deployment-contract.json"]))
    if contract != {"schemaVersion": 1, "mode": "protected-a3"}:
        raise DeploymentError("TEAM 2 image is not a protected A3 runtime")
    validate_compose(validated, environment_file, runner)

    state_path = state_root / "state.json"
    previous_state = safe_json(state_path, "TEAM 2 deployment state") if state_path.exists() else None
    previous_worker = resolve_previous_worker(previous_state, runner)
    previous_a3 = previous_worker["container"] if previous_worker["kind"] == "protected" else ""
    legacy = previous_worker["container"] if previous_worker["kind"] == "legacy" else ""
    if legacy:
        identity = runner(["docker", "exec", legacy, "printenv", "SPX_ROLE", "RUN_TEAM_IDS", "SPX_NODE_ID"]).splitlines()
        if identity != ["worker", "2", NODE_ID]:
            raise DeploymentError("TEAM 2 legacy worker identity is invalid")

    command = compose(validated, environment_file)
    environment = compose_environment(validated)
    stopped_legacy = legacy
    try:
        if stopped_legacy:
            runner(["docker", "stop", "-t", "120", stopped_legacy])
        elif previous_a3:
            runner(command + ["--profile", "split", "stop", "-t", "120", SERVICE], environment=environment)
        runner(command + ["--profile", "split", "up", "-d", "--no-build", "--pull", "never", "--force-recreate", SERVICE], environment=environment)
        container = wait_ready(validated, environment_file, runner)
    except Exception as failure:
        try:
            runner(command + ["--profile", "split", "rm", "-s", "-f", SERVICE], environment=environment)
            if stopped_legacy:
                runner(["docker", "start", stopped_legacy])
            elif previous_state:
                previous_release = Path(previous_state["releaseDir"])
                previous = validate_release(previous_release, previous_state["releaseManifestSha256"], previous_state["targetDescriptorSha256"])
                previous_command = compose(previous, environment_file)
                runner(previous_command + ["--profile", "split", "up", "-d", "--no-build", "--pull", "never", "--force-recreate", SERVICE], environment=compose_environment(previous))
                wait_ready(previous, environment_file, runner)
        except Exception as rollback_failure:
            raise DeploymentError("TEAM 2 deployment and rollback both failed") from rollback_failure
        raise DeploymentError("TEAM 2 deployment failed and the verified prior worker was restored") from failure

    state = {
        "schemaVersion": 1,
        "deploymentUnit": "team2",
        "service": SERVICE,
        "teamId": TEAM_ID,
        "nodeId": NODE_ID,
        "releaseDir": str(validated["release"]),
        "sourceSha": validated["manifest"]["sourceSha"],
        "imageId": image_id,
        "releaseManifestSha256": validated["manifestSha256"],
        "targetDescriptorSha256": validated["descriptorSha256"],
        "containerId": container,
    }
    atomic_write(state_path, canonical_json(state).encode(), 0o400)
    active_new = managed_root / ".current.new"
    active_new.unlink(missing_ok=True)
    active_new.symlink_to(validated["release"], target_is_directory=True)
    os.replace(active_new, managed_root / "current")
    return state


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("validate", "install"))
    parser.add_argument("--release-dir", type=Path, required=True)
    parser.add_argument("--release-manifest-sha256", required=True)
    parser.add_argument("--target-descriptor-sha256", required=True)
    parser.add_argument("--managed-root", type=Path, default=Path("/opt/spx-production-team2"))
    parser.add_argument("--state-root", type=Path, default=Path("/var/lib/spx-production-team2-rollout"))
    parser.add_argument("--environment-file", type=Path, default=Path("/etc/spx-production/runtime.env"))
    parser.add_argument("--operation-id")
    return parser.parse_args()


def main():
    args = parse_args()
    validated = validate_release(args.release_dir, args.release_manifest_sha256, args.target_descriptor_sha256)
    if args.action == "validate":
        result = {"ok": True, "deploymentUnit": "team2", "service": SERVICE, "teamId": TEAM_ID, "nodeId": NODE_ID}
    else:
        if not args.operation_id or not re.fullmatch(r"[A-Za-z0-9._-]{1,160}", args.operation_id):
            raise DeploymentError("TEAM 2 operation ID is invalid")
        paths = validated["descriptor"]["target"]["canonicalPaths"]
        if args.managed_root != Path(paths["releaseRoot"]) or args.state_root != Path(paths["stateRoot"]):
            raise DeploymentError("TEAM 2 install paths do not match the signed descriptor")
        if args.managed_root.is_symlink() or args.state_root.is_symlink():
            raise DeploymentError("TEAM 2 managed path is unsafe")
        args.managed_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        (args.managed_root / "releases").mkdir(exist_ok=True, mode=0o700)
        args.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        import fcntl
        with (args.state_root / "deploy.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = install_release(
                validated,
                args.managed_root,
                args.state_root,
                args.environment_file,
                args.operation_id,
            )
    print(canonical_json(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = str(error) if isinstance(error, DeploymentError) else "TEAM 2 deployment validation failed"
        print(message, file=os.sys.stderr)
        raise SystemExit(1)
