#!/usr/bin/env python3
"""Install the first protected A3 primary unit with exact legacy rollback."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time


PROJECT = "spx-production"
LEGACY_PROJECT = "spx"
SERVICES = ("line-service", "notification-service", "ocr-service", "web-api", "worker-ptwl-split")
LEGACY_SERVICES = ("notifier", "worker-ptwl")
NODE_IDS = {
    "line-service": "prod-line-service-1",
    "notification-service": "prod-notification-service-1",
    "ocr-service": "prod-ocr-service-1",
    "web-api": "prod-web-api-1",
    "worker-ptwl-split": "prod-worker-ptwl-split-1",
}
SHA256 = re.compile(r"^[0-9a-f]{64}$")
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}$")
CONTAINER_ID = re.compile(r"^[0-9a-f]{12,64}$")


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
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.new")
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        if os.name == "nt" and path.exists():
            os.chmod(path, 0o600)
        os.replace(temporary, path)
        if os.name == "posix":
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        if temporary.exists() and os.name == "nt":
            os.chmod(temporary, 0o600)
        temporary.unlink(missing_ok=True)


def run_command(command, input_text=None, environment=None):
    result = subprocess.run(
        command, input=input_text, text=True, capture_output=True,
        timeout=300, env=environment,
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
        "compose": release / "operator" / "docker-compose.a3.yml",
        "overlay": release / "operator" / "deploy" / "production-primary.yml",
        "image": release / "spx-image.tar",
    }
    for label, path in required.items():
        if path.is_symlink() or not path.is_file():
            raise DeploymentError(f"primary {label} file is missing or unsafe")
    if not SHA256.fullmatch(release_manifest_sha256) or digest(required["manifest"]) != release_manifest_sha256:
        raise DeploymentError("primary release manifest digest mismatch")
    if not SHA256.fullmatch(target_descriptor_sha256) or digest(required["descriptor"]) != target_descriptor_sha256:
        raise DeploymentError("primary target descriptor digest mismatch")

    manifest = safe_json(required["manifest"], "release manifest")
    source_sha = manifest.get("sourceSha", "")
    image_id = manifest.get("imageId", "")
    image_tag = manifest.get("imageTag", "")
    bundle_sha = manifest.get("operatorBundleSha256", "")
    if not SOURCE_SHA.fullmatch(source_sha) or not IMAGE_ID.fullmatch(image_id):
        raise DeploymentError("primary release identity is invalid")
    if image_tag != f"spx-app:{source_sha}" or not SHA256.fullmatch(bundle_sha):
        raise DeploymentError("primary release tuple is invalid")

    signed = safe_json(required["descriptor"], "target descriptor")
    descriptor = signed.get("descriptor") if isinstance(signed, dict) else None
    signature = signed.get("signature") if isinstance(signed, dict) else None
    if not isinstance(descriptor, dict) or not isinstance(signature, dict):
        raise DeploymentError("primary target descriptor is malformed")
    expected = {
        "releaseEnvironment": "production", "runtimeEnvironment": "production",
        "deploymentUnit": "primary", "composeProject": PROJECT, "topology": "split",
        "releaseManifestSha256": release_manifest_sha256, "releaseSourceSha": source_sha,
        "imageId": image_id, "imageTag": image_tag, "operatorBundleSha256": bundle_sha,
    }
    if signed.get("schemaVersion") != 1 or signature.get("algorithm") != "Ed25519":
        raise DeploymentError("primary target descriptor signature metadata is invalid")
    if any(descriptor.get(key) != value for key, value in expected.items()):
        raise DeploymentError("primary target descriptor does not match the immutable release")
    if descriptor.get("publishedPorts") != [3000] or descriptor.get("nodeIds") != sorted(NODE_IDS.values()):
        raise DeploymentError("primary target descriptor has the wrong node or port scope")
    canonical_paths = descriptor.get("target", {}).get("canonicalPaths", {})
    if canonical_paths != {
        "releaseRoot": "/opt/spx-production/release",
        "environmentFile": "/etc/spx-production/runtime.env",
        "stateRoot": "/var/lib/spx-production-rollout",
    }:
        raise DeploymentError("primary target descriptor canonical paths are invalid")

    topology = json.loads(required["topology"].read_text(encoding="utf8"))
    if topology.get("topology") != "split-two-host" or topology.get("deploymentOrder") != ["primary", "team2"]:
        raise DeploymentError("primary production topology is invalid")
    units = topology.get("units")
    unit = units[0] if isinstance(units, list) and len(units) == 2 else None
    if not isinstance(unit, dict) or unit.get("id") != "primary" or unit.get("host") != "45.83.207.139":
        raise DeploymentError("primary production topology target is invalid")
    if [service.get("name") for service in unit.get("services", [])] != list(SERVICES):
        raise DeploymentError("primary production topology service set is invalid")
    return {
        "release": release, "manifest": manifest, "descriptor": descriptor,
        "manifestSha256": release_manifest_sha256, "descriptorSha256": target_descriptor_sha256,
    }


def runtime_context(validated, operation_id):
    manifest = validated["manifest"]
    return {
        "schemaVersion": 1, "operationId": operation_id, "target": "production",
        "deploymentUnit": "primary", "sourceSha": manifest["sourceSha"],
        "imageId": manifest["imageId"], "imageTag": manifest["imageTag"],
        "topology": "split", "composeProject": PROJECT,
        "releaseManifestSha256": validated["manifestSha256"],
        "operatorBundleSha256": manifest["operatorBundleSha256"],
        "descriptorArtifactSha256": validated["descriptorSha256"],
    }


def compose(validated, environment_file):
    release = validated["release"]
    return [
        "docker", "compose", "-p", PROJECT, "--env-file", str(environment_file),
        "-f", str(release / "operator" / "docker-compose.a3.yml"),
        "-f", str(release / "operator" / "deploy" / "production-primary.yml"),
    ]


def compose_environment(validated):
    release = validated["release"]
    manifest = validated["manifest"]
    return {
        **os.environ, "SPX_IMAGE": manifest["imageTag"], "SPX_RELEASE_SHA": manifest["sourceSha"],
        "SPX_TARGET_DESCRIPTOR_SHA256": validated["descriptorSha256"],
        "SPX_OPERATOR_BUNDLE_SHA256": manifest["operatorBundleSha256"],
        "SPX_RELEASE_MANIFEST_PATH": str(release / "release-manifest.json"),
        "SPX_TARGET_DESCRIPTOR_PATH": str(release / "deployment-target-descriptor.json"),
        "SPX_DEPLOYMENT_CONTEXT_PATH": str(release / "deployment-context.json"),
    }


def active_service_containers(project, service, runner=run_command):
    values = runner([
        "docker", "ps", "--no-trunc", "-q",
        "--filter", f"label=com.docker.compose.project={project}",
        "--filter", f"label=com.docker.compose.service={service}",
    ]).splitlines()
    if len(values) != len(set(values)) or any(not CONTAINER_ID.fullmatch(value) for value in values):
        raise DeploymentError("primary container inventory is invalid")
    return values


def inspect_legacy(runner=run_command):
    if any(active_service_containers(PROJECT, service, runner) for service in SERVICES):
        raise DeploymentError("primary found an unmanaged A3 candidate")
    legacy = {}
    for service in LEGACY_SERVICES:
        containers = active_service_containers(LEGACY_PROJECT, service, runner)
        if len(containers) != 1:
            raise DeploymentError("primary adoption requires the exact legacy service set")
        legacy[service] = containers[0]
    if active_service_containers(LEGACY_PROJECT, "worker-ifn", runner):
        raise DeploymentError("primary must not own TEAM 2")
    identity = runner(["docker", "exec", legacy["worker-ptwl"], "printenv", "SPX_ROLE", "RUN_TEAM_IDS", "SPX_NODE_ID"]).splitlines()
    if identity != ["worker", "1", "prod-worker-ptwl-1"]:
        raise DeploymentError("primary legacy worker identity is invalid")
    for container in legacy.values():
        state = runner(["docker", "inspect", "--format", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}", container])
        if state != "running|healthy|0":
            raise DeploymentError("primary legacy service is not healthy")
    return legacy


def validate_compose(validated, environment_file, runner=run_command):
    command = compose(validated, environment_file)
    environment = compose_environment(validated)
    services = runner(command + ["--profile", "split", "config", "--services"], environment=environment).splitlines()
    selected = [service for service in services if service in SERVICES]
    if sorted(selected) != sorted(SERVICES) or len(selected) != len(SERVICES):
        raise DeploymentError("primary Compose projection has the wrong service set")
    model = json.loads(runner(command + ["--profile", "split", "config", "--format", "json"], environment=environment))
    for service in SERVICES:
        item = model.get("services", {}).get(service, {})
        if item.get("image") != validated["manifest"]["imageTag"]:
            raise DeploymentError("primary Compose image is not immutable")
    web_ports = model["services"]["web-api"].get("ports", [])
    if len(web_ports) != 1 or str(web_ports[0].get("published")) != "3000" or web_ports[0].get("host_ip") != "127.0.0.1":
        raise DeploymentError("primary web port binding is invalid")
    worker = model["services"]["worker-ptwl-split"].get("environment", {})
    if str(worker.get("RUN_TEAM_IDS")) != "1" or worker.get("SPX_NODE_ID") != NODE_IDS["worker-ptwl-split"]:
        raise DeploymentError("primary worker identity is invalid")


def validate_container(service, container, image_id, runner=run_command):
    if not CONTAINER_ID.fullmatch(container):
        raise DeploymentError("primary container identity is invalid")
    if runner(["docker", "inspect", "--format", "{{.Image}}", container]) != image_id:
        raise DeploymentError("primary container image is invalid")
    node = runner(["docker", "exec", container, "printenv", "SPX_NODE_ID"])
    if node != NODE_IDS[service]:
        raise DeploymentError("primary container node identity is invalid")
    if service == "worker-ptwl-split":
        identity = runner(["docker", "exec", container, "printenv", "SPX_ROLE", "RUN_TEAM_IDS"]).splitlines()
        if identity != ["worker", "1"]:
            raise DeploymentError("primary worker team identity is invalid")


def wait_ready(validated, environment_file, runner=run_command, sleep=time.sleep, attempts=60):
    command = compose(validated, environment_file)
    environment = compose_environment(validated)
    for attempt in range(attempts):
        try:
            containers = {}
            for service in SERVICES:
                container = runner(command + ["--profile", "split", "ps", "-q", service], environment=environment)
                state = runner(["docker", "inspect", "--format", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}", container])
                if state != "running|healthy|0":
                    raise DeploymentError("primary service is not healthy")
                validate_container(service, container, validated["manifest"]["imageId"], runner)
                containers[service] = container
            runner(["curl", "--fail", "--silent", "--show-error", "--connect-timeout", "3", "--max-time", "10", "http://127.0.0.1:3000/ready"])
            return containers
        except (DeploymentError, KeyError, ValueError):
            pass
        if attempt + 1 < attempts:
            sleep(3)
    raise DeploymentError("primary candidate failed image, identity, or health readiness")


def copy_legacy_line_state(source, runner=run_command):
    source = Path(source)
    if not source.exists():
        return
    if source.is_symlink() or not source.is_dir():
        raise DeploymentError("legacy LINE state path is unsafe")
    for directory, names, files in os.walk(source, followlinks=False):
        directory = Path(directory)
        for name in (*names, *files):
            entry = directory / name
            if entry.is_symlink() or (not entry.is_dir() and not entry.is_file()):
                raise DeploymentError("legacy LINE state contains an unsafe entry")
    volume = f"{PROJECT}_line-state-split"
    runner(["docker", "volume", "create", volume])
    mountpoint = Path(runner(["docker", "volume", "inspect", "--format", "{{.Mountpoint}}", volume]))
    expected_mountpoint = Path("/var/lib/docker/volumes") / volume / "_data"
    if mountpoint != expected_mountpoint or mountpoint.is_symlink() or not mountpoint.is_dir():
        raise DeploymentError("primary LINE state volume is unsafe")
    for existing in mountpoint.iterdir():
        if existing.is_symlink():
            existing.unlink()
        elif existing.is_dir():
            shutil.rmtree(existing)
        else:
            existing.unlink()
    for item in source.iterdir():
        destination = mountpoint / item.name
        if item.is_symlink():
            raise DeploymentError("legacy LINE state contains a symlink")
        if item.is_dir():
            shutil.copytree(item, destination)
        elif item.is_file():
            shutil.copy2(item, destination)


def commit_projection(release, operation_id, active_projection, backup_root):
    active = Path(active_projection)
    backup = Path(backup_root) / operation_id / "SPX"
    if active.is_symlink():
        if active.resolve() != release / "operator":
            raise DeploymentError("primary active projection points to an unexpected release")
        return str(backup)
    if not active.is_dir() or backup.exists():
        raise DeploymentError("primary legacy projection cannot be committed safely")
    backup.parent.mkdir(parents=True, mode=0o700)
    os.rename(active, backup)
    try:
        temporary = active.with_name(f".{active.name}.{operation_id}.new")
        temporary.symlink_to(release / "operator", target_is_directory=True)
        os.replace(temporary, active)
    except Exception:
        if not active.exists():
            os.rename(backup, active)
        raise
    return str(backup)


def restore_projection(active_projection, backup):
    active = Path(active_projection)
    backup = Path(backup)
    if active.is_symlink():
        active.unlink()
    if not active.exists() and backup.is_dir():
        os.rename(backup, active)


def install_release(
    validated, state_root, environment_file, operation_id,
    active_projection="/root/SPX", backup_root="/root/spx-legacy-projection",
    legacy_line_state="/root/SPX/data/line-state", runner=run_command,
    waiter=wait_ready,
    projection_committer=commit_projection, projection_restorer=restore_projection,
):
    state_root = Path(state_root)
    environment_file = Path(environment_file)
    if environment_file.is_symlink() or not environment_file.is_file():
        raise DeploymentError("primary protected environment file is missing or unsafe")
    legacy = inspect_legacy(runner)
    context_path = validated["release"] / "deployment-context.json"
    context_bytes = canonical_json(runtime_context(validated, operation_id)).encode()
    if context_path.exists():
        if context_path.is_symlink() or context_path.read_bytes() != context_bytes:
            raise DeploymentError("primary deployment context does not match this operation")
    else:
        atomic_write(context_path, context_bytes, 0o444)

    runner(["docker", "load", "--input", str(validated["release"] / "spx-image.tar")])
    image_id = validated["manifest"]["imageId"]
    image_tag = validated["manifest"]["imageTag"]
    if runner(["docker", "image", "inspect", "--format", "{{.Id}}", image_tag]) != image_id:
        raise DeploymentError("primary loaded image identity mismatch")
    contract = json.loads(runner(["docker", "run", "--rm", "--network", "none", "--entrypoint", "cat", image_id, "/app/dist/deployment-contract.json"]))
    if contract != {"schemaVersion": 1, "mode": "protected-a3"}:
        raise DeploymentError("primary image is not a protected A3 runtime")
    validate_compose(validated, environment_file, runner)
    command = compose(validated, environment_file)
    environment = compose_environment(validated)
    runner(command + ["--profile", "migration", "run", "--rm", "--no-deps", "migrator"], environment=environment)

    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    journal = {
        "schemaVersion": 1, "operationId": operation_id, "state": "prepared",
        "legacyContainers": legacy, "sourceSha": validated["manifest"]["sourceSha"],
    }
    state_path = state_root / "state.json"
    atomic_write(state_path, canonical_json(journal).encode(), 0o400)
    backup = None
    try:
        for service in LEGACY_SERVICES:
            runner(["docker", "stop", "-t", "120", legacy[service]])
        copy_legacy_line_state(legacy_line_state, runner)
        journal["state"] = "legacy-stopped"
        atomic_write(state_path, canonical_json(journal).encode(), 0o400)
        runner(command + ["--profile", "split", "up", "-d", "--no-build", "--pull", "never", "--force-recreate", *SERVICES], environment=environment)
        journal["state"] = "candidate-started"
        atomic_write(state_path, canonical_json(journal).encode(), 0o400)
        containers = waiter(validated, environment_file, runner)
        journal["state"] = "healthy"
        journal["candidateContainers"] = containers
        atomic_write(state_path, canonical_json(journal).encode(), 0o400)
        backup = projection_committer(validated["release"], operation_id, active_projection, backup_root)
        journal.update({"state": "committed", "legacyProjectionBackup": backup})
        atomic_write(state_path, canonical_json(journal).encode(), 0o400)
        return journal
    except Exception as failure:
        try:
            if backup:
                projection_restorer(active_projection, backup)
            runner(command + ["--profile", "split", "rm", "-s", "-f", *SERVICES], environment=environment)
            for service in LEGACY_SERVICES:
                runner(["docker", "start", legacy[service]])
            for service in LEGACY_SERVICES:
                state = runner(["docker", "inspect", "--format", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}|{{.RestartCount}}", legacy[service]])
                if state != "running|healthy|0":
                    raise DeploymentError("primary rollback did not restore legacy health")
            journal["state"] = "rolled-back"
            atomic_write(state_path, canonical_json(journal).encode(), 0o400)
        except Exception as rollback_failure:
            raise DeploymentError("primary deployment and rollback both failed") from rollback_failure
        raise DeploymentError("primary deployment failed and the verified legacy pair was restored") from failure


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("validate", "install"))
    parser.add_argument("--release-dir", type=Path, required=True)
    parser.add_argument("--release-manifest-sha256", required=True)
    parser.add_argument("--target-descriptor-sha256", required=True)
    parser.add_argument("--state-root", type=Path, default=Path("/var/lib/spx-production-rollout"))
    parser.add_argument("--environment-file", type=Path, default=Path("/etc/spx-production/runtime.env"))
    parser.add_argument("--operation-id")
    return parser.parse_args()


def main():
    args = parse_args()
    validated = validate_release(args.release_dir, args.release_manifest_sha256, args.target_descriptor_sha256)
    if args.action == "validate":
        result = {"ok": True, "deploymentUnit": "primary", "services": list(SERVICES), "teamId": 1}
    else:
        if os.geteuid() != 0 or not args.operation_id or not re.fullmatch(r"[A-Za-z0-9._-]{1,160}", args.operation_id):
            raise DeploymentError("primary install identity is invalid")
        if args.state_root != Path("/var/lib/spx-production-rollout") or args.environment_file != Path("/etc/spx-production/runtime.env"):
            raise DeploymentError("primary install paths are not canonical")
        if args.state_root.is_symlink() or args.environment_file.parent.is_symlink():
            raise DeploymentError("primary protected runtime path is unsafe")
        import fcntl
        args.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (args.state_root / "deploy.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = install_release(validated, args.state_root, args.environment_file, args.operation_id)
    print(canonical_json(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = str(error) if isinstance(error, DeploymentError) else "primary deployment validation failed"
        print(message, file=os.sys.stderr)
        raise SystemExit(1)
