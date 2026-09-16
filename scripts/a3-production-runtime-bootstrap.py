#!/usr/bin/env python3
"""Materialize root-only A3 production runtime configuration without logging secrets."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess


PRIMARY_HOST = "tms.pathwaylogistic.com"
TEAM2_HOST = "localhost"
DB_FILE_ROLES = (
    "MIGRATOR", "NOTIFIER", "WEB_API", "NOTIFICATION_SERVICE", "LINE_SERVICE",
    "WORKER_IFN_SPLIT", "WORKER_PTWL_SPLIT", "WORKER_IFN", "WORKER_PTWL",
    "POLLER_IFN_PHASE3", "AUTO_ACCEPT_IFN_PHASE3", "POLLER_PTWL_PHASE3",
    "AUTO_ACCEPT_PTWL_PHASE3", "REALTIME_SERVICE", "GATE6_CONTROL", "GATE6_MONITOR",
)
NOTIFICATION_NODES = {
    "prod-worker-ifn-split-1": "2",
    "prod-worker-ifn-node2": "2",
    "prod-worker-ptwl-split-1": "1",
    "prod-worker-ifn-1": "2",
    "prod-worker-ptwl-1": "1",
    "prod-poller-ifn-phase3-1": "2",
    "prod-auto-accept-ifn-phase3-1": "2",
    "prod-poller-ptwl-phase3-1": "1",
    "prod-auto-accept-ptwl-phase3-1": "1",
}
REALTIME_NODES = tuple(sorted({
    "prod-notifier-1", "prod-web-api-1", "prod-notification-service-1",
    *NOTIFICATION_NODES.keys(),
}))
SAFE_VALUE = re.compile(r"^[A-Za-z0-9_./:@,+-]+$")


class BootstrapError(RuntimeError):
    pass


def ensure_private_directory(path):
    path = Path(path)
    if path.is_symlink():
        raise BootstrapError("protected runtime directory is unsafe")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or not path.is_dir():
        raise BootstrapError("protected runtime directory is unsafe")
    if os.name == "posix":
        status = path.stat()
        if status.st_uid != os.geteuid():
            raise BootstrapError("protected runtime directory owner is unsafe")
        os.chmod(path, 0o700)


def validate_private_file(path, maximum_bytes=64 * 1024):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise BootstrapError("protected runtime secret is unsafe")
    status = path.stat()
    if status.st_size < 1 or status.st_size > maximum_bytes or status.st_nlink != 1:
        raise BootstrapError("protected runtime secret is unsafe")
    if os.name == "posix" and status.st_uid != os.geteuid():
        raise BootstrapError("protected runtime secret owner is unsafe")
    os.chmod(path, 0o400)
    return status


def parse_dotenv(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise BootstrapError("legacy environment file is missing or unsafe")
    values = {}
    for raw in path.read_text(encoding="utf8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise BootstrapError("legacy environment file is invalid")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in values:
            raise BootstrapError("legacy environment file is invalid")
        if value.startswith('"'):
            try:
                value = json.loads(value)
            except json.JSONDecodeError as error:
                raise BootstrapError("legacy environment file is invalid") from error
        elif value.startswith("'"):
            if len(value) < 2 or not value.endswith("'"):
                raise BootstrapError("legacy environment file is invalid")
            value = value[1:-1]
        values[key] = value
    for key in ("DB_USERNAME", "DB_PASSWORD", "SECRETS_KEY"):
        if not values.get(key):
            raise BootstrapError("legacy environment is missing required protected values")
    if len(values["SECRETS_KEY"]) < 32:
        raise BootstrapError("legacy SECRETS_KEY is invalid")
    return values


def atomic_write(path, data, mode):
    path = Path(path)
    ensure_private_directory(path.parent)
    if path.is_symlink():
        raise BootstrapError("protected runtime path is unsafe")
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


def private_value(path, create=None):
    path = Path(path)
    if path.exists():
        validate_private_file(path)
        value = path.read_text(encoding="utf8").strip()
        if not value or "\n" in value or "\r" in value:
            raise BootstrapError("protected runtime secret is invalid")
        return value
    value = create() if create else secrets.token_urlsafe(48)
    if not value or "\n" in value or "\r" in value:
        raise BootstrapError("protected runtime secret is invalid")
    atomic_write(path, value.encode(), 0o400)
    return value


def secret_path(root, name):
    return Path(root) / "secrets" / name


def write_pair_map(path, values):
    content = ",".join(f"{key}={values[key]}" for key in sorted(values))
    atomic_write(path, content.encode(), 0o400)


def quote_env(value):
    value = str(value)
    if SAFE_VALUE.fullmatch(value):
        return value
    return json.dumps(value, ensure_ascii=True)


def ensure_ed25519_pair(private_path, public_path):
    private_path = Path(private_path)
    public_path = Path(public_path)
    if private_path.exists() and public_path.exists():
        validate_private_file(private_path)
        validate_private_file(public_path)
        os.chmod(public_path, 0o444)
        return
    if private_path.exists() or public_path.exists():
        raise BootstrapError("permit key pair is incomplete")
    ensure_private_directory(private_path.parent)
    private_new = private_path.with_name(f".{private_path.name}.{os.getpid()}.new")
    public_new = public_path.with_name(f".{public_path.name}.{os.getpid()}.new")
    try:
        subprocess.run(
            ["openssl", "genpkey", "-algorithm", "ED25519", "-out", str(private_new)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
        )
        subprocess.run(
            ["openssl", "pkey", "-in", str(private_new), "-pubout", "-out", str(public_new)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
        )
        os.chmod(private_new, 0o400)
        os.chmod(public_new, 0o444)
        os.replace(private_new, private_path)
        os.replace(public_new, public_path)
    finally:
        private_new.unlink(missing_ok=True)
        public_new.unlink(missing_ok=True)


def prepare_runtime(unit, legacy_env, ca_source, root):
    if unit not in ("primary", "team2"):
        raise BootstrapError("deployment unit is invalid")
    root = Path(root)
    if root.is_symlink():
        raise BootstrapError("protected runtime root is unsafe")
    ensure_private_directory(root)
    ensure_private_directory(root / "secrets")
    ensure_private_directory(root / "config")
    legacy = parse_dotenv(legacy_env)

    ca_source = Path(ca_source)
    if ca_source.is_symlink() or not ca_source.is_file():
        raise BootstrapError("database CA source is missing or unsafe")
    ca_bytes = ca_source.read_bytes()
    if b"-----BEGIN CERTIFICATE-----" not in ca_bytes:
        raise BootstrapError("database CA source is invalid")
    ca_path = root / "config" / "db-ca.pem"
    atomic_write(ca_path, ca_bytes, 0o444)

    db_password_path = secret_path(root, "db-password-legacy")
    secrets_key_path = secret_path(root, "secrets-key")
    private_value(db_password_path, lambda: legacy["DB_PASSWORD"])
    private_value(secrets_key_path, lambda: legacy["SECRETS_KEY"])

    if unit == "team2":
        notification_path = secret_path(root, "notification-prod-worker-ifn-node2")
        realtime_path = secret_path(root, "realtime-prod-worker-ifn-node2")
        private_value(notification_path)
        private_value(realtime_path)
        values = {
            "SPX_DB_HOST": TEAM2_HOST,
            "SPX_DB_PORT": "3306",
            "SPX_DB_NAME": legacy.get("DB_NAME", "SPX"),
            "SPX_DB_SSL_SERVERNAME": PRIMARY_HOST,
            "SPX_DB_CA_PATH": ca_path,
            "SPX_DB_USERNAME_WORKER_IFN_SPLIT": legacy["DB_USERNAME"],
            "SPX_DB_PASSWORD_WORKER_IFN_SPLIT_FILE": db_password_path,
            "SPX_SECRETS_KEY_FILE": secrets_key_path,
            "SPX_NOTIFICATION_NODE_SECRET_WORKER_IFN_SPLIT_FILE": notification_path,
            "SPX_REALTIME_SHARED_SECRET_WORKER_IFN_SPLIT_FILE": realtime_path,
            "SPX_TEAM2_NOTIFICATION_API_URL": "http://127.0.0.1:3000/internal/notification-events",
            "SPX_REALTIME_WORKER_IFN_SPLIT_URL": "",
            "SPX_REALTIME_REQUEST_TIMEOUT_MS": "1500",
        }
        write_runtime_env(root / "runtime.env", values)
        return {"unit": unit, "environmentFile": str(root / "runtime.env"), "notificationSecretFile": str(notification_path)}

    generated = {}
    for name in ("jwt", "cookie", "admin", "line-admin"):
        generated[name] = private_value(secret_path(root, name))

    notification_secrets = {}
    for node in NOTIFICATION_NODES:
        path = secret_path(root, f"notification-{node}")
        notification_secrets[node] = private_value(path)
    notification_map = secret_path(root, "notification-node-secrets")
    write_pair_map(notification_map, notification_secrets)

    line_sender = {"prod-notification-service-1": private_value(secret_path(root, "line-send-prod-notification-service-1"))}
    line_sender_map = secret_path(root, "line-send-node-secrets")
    write_pair_map(line_sender_map, line_sender)

    ocr = {
        "prod-line-service-1": private_value(secret_path(root, "ocr-prod-line-service-1")),
        "prod-web-api-1": private_value(secret_path(root, "ocr-prod-web-api-1")),
    }
    ocr_map = secret_path(root, "ocr-node-secrets")
    write_pair_map(ocr_map, ocr)

    realtime = {}
    for node in REALTIME_NODES:
        realtime[node] = private_value(secret_path(root, f"realtime-{node}"))
    realtime_map = secret_path(root, "realtime-node-secrets")
    write_pair_map(realtime_map, realtime)

    gate6_line = private_value(secret_path(root, "gate6-control-line"))
    gate6_ocr = private_value(secret_path(root, "gate6-control-ocr"))
    gate6_line_map = secret_path(root, "gate6-line-node-secrets")
    gate6_ocr_map = secret_path(root, "gate6-ocr-node-secrets")
    write_pair_map(gate6_line_map, {"prod-gate6-control-1": gate6_line})
    write_pair_map(gate6_ocr_map, {"prod-gate6-control-1": gate6_ocr})

    line_private = secret_path(root, "gate6-line-permit-private.pem")
    line_public = root / "config" / "gate6-line-permit-public.pem"
    ocr_private = secret_path(root, "gate6-ocr-permit-private.pem")
    ocr_public = root / "config" / "gate6-ocr-permit-public.pem"
    ensure_ed25519_pair(line_private, line_public)
    ensure_ed25519_pair(ocr_private, ocr_public)

    placeholders = {
        "gate6-keyring.json": {"schemaVersion": 1, "keys": []},
        "gate6-task9-requests.json": {"schemaVersion": 1, "requests": []},
    }
    for name, value in placeholders.items():
        atomic_write(root / "config" / name, json.dumps(value, sort_keys=True, separators=(",", ":")).encode(), 0o400)

    values = {
        "SPX_DB_HOST": PRIMARY_HOST,
        "SPX_DB_PORT": "3306",
        "SPX_DB_NAME": legacy.get("DB_NAME", "SPX"),
        "SPX_DB_SSL_SERVERNAME": PRIMARY_HOST,
        "SPX_DB_CA_PATH": ca_path,
        "SPX_SECRETS_KEY_FILE": secrets_key_path,
        "SPX_JWT_SECRET_FILE": secret_path(root, "jwt"),
        "SPX_COOKIE_SECRET_FILE": secret_path(root, "cookie"),
        "SPX_ADMIN_PASSWORD_FILE": secret_path(root, "admin"),
        "SPX_ADMIN_USERNAME": "admin",
        "SPX_NOTIFICATION_NODE_SECRETS_FILE": notification_map,
        "SPX_NOTIFICATION_ALLOWED_NODE_TEAMS": ",".join(f"{node}={NOTIFICATION_NODES[node]}" for node in sorted(NOTIFICATION_NODES)),
        "SPX_LINE_SERVICE_SEND_SECRET_NOTIFICATION_SERVICE_FILE": secret_path(root, "line-send-prod-notification-service-1"),
        "SPX_LINE_SERVICE_SEND_NODE_SECRETS_FILE": line_sender_map,
        "SPX_LINE_SERVICE_ADMIN_SECRET_FILE": secret_path(root, "line-admin"),
        "SPX_LINE_SEND_ALLOWED_NODE_IDS": "prod-notification-service-1",
        "SPX_LINE_ADMIN_ALLOWED_NODE_IDS": "prod-web-api-1",
        "SPX_OCR_NODE_SECRETS_FILE": ocr_map,
        "SPX_OCR_NODE_SECRET_WEB_API_FILE": secret_path(root, "ocr-prod-web-api-1"),
        "SPX_OCR_NODE_SECRET_LINE_SERVICE_FILE": secret_path(root, "ocr-prod-line-service-1"),
        "SPX_OCR_NODE_SECRET_NOTIFIER_FILE": secret_path(root, "ocr-prod-web-api-1"),
        "SPX_OCR_ALLOWED_LINE_NODE_IDS": "prod-line-service-1",
        "SPX_OCR_ADMIN_NODE_IDS": "prod-web-api-1",
        "SPX_NOTIFIER_OCR_SERVICE_URL": "http://ocr-service:3004",
        "SPX_GATE6_CONTROL_NODE_SECRET_LINE_FILE": secret_path(root, "gate6-control-line"),
        "SPX_GATE6_CONTROL_NODE_SECRET_OCR_FILE": secret_path(root, "gate6-control-ocr"),
        "SPX_GATE6_LINE_NODE_SECRETS_FILE": gate6_line_map,
        "SPX_GATE6_OCR_NODE_SECRETS_FILE": gate6_ocr_map,
        "SPX_GATE6_LINE_PERMIT_KEY_ID": "spx-gate6-line-v1",
        "SPX_GATE6_OCR_PERMIT_KEY_ID": "spx-gate6-ocr-v1",
        "SPX_GATE6_LINE_PERMIT_PUBLIC_KEY_FILE": line_public,
        "SPX_GATE6_OCR_PERMIT_PUBLIC_KEY_FILE": ocr_public,
        "SPX_GATE6_TASK9_LINE_CALLER_SECRET_FILE": secret_path(root, "gate6-control-line"),
        "SPX_GATE6_TASK9_OCR_CALLER_SECRET_FILE": secret_path(root, "gate6-control-ocr"),
        "SPX_GATE6_PRODUCTION_KEYRING_PATH": root / "config" / "gate6-keyring.json",
        "SPX_GATE6_TASK9_REQUEST_CONFIG_PATH": root / "config" / "gate6-task9-requests.json",
        "SPX_GATE6_REPOSITORY": "fastest4u/SPX",
        "SPX_GATE6_CONTROL_REQUEST_TIMEOUT_MS": "1500",
        "SPX_GATE6_DB_CA_SHA256": hashlib.sha256(ca_bytes).hexdigest(),
        "SPX_GATE6_DB_PASSWORD_SHA256": hashlib.sha256(legacy["DB_PASSWORD"].encode()).hexdigest(),
        "SPX_REALTIME_NODE_SECRETS_WEB_API_FILE": realtime_map,
        "SPX_REALTIME_NODE_SECRETS_REALTIME_SERVICE_FILE": realtime_map,
        "SPX_REALTIME_TRUSTED_NODE_IDS": ",".join(REALTIME_NODES),
        "SPX_REALTIME_ADMIN_NODE_IDS": "prod-web-api-1",
        "SPX_REALTIME_ALLOWED_NODE_TEAMS": ",".join(f"{node}={NOTIFICATION_NODES[node]}" for node in sorted(NOTIFICATION_NODES)),
        "SPX_REALTIME_ALLOWED_NODE_TEAMS_WEB_API": "",
        "SPX_REALTIME_ALLOWED_NODE_TEAMS_NOTIFIER": "",
        "SPX_REALTIME_ALLOWED_NODE_TEAMS_NOTIFICATION_SERVICE": "",
        "SPX_REALTIME_REQUEST_TIMEOUT_MS": "1500",
        "SPX_AUTO_ACCEPT_JOB_CUTOVER_EPOCH_IFN": "disabled",
        "SPX_AUTO_ACCEPT_JOB_CUTOVER_EPOCH_PTWL": "disabled",
    }
    for role in DB_FILE_ROLES:
        values[f"SPX_DB_USERNAME_{role}"] = legacy["DB_USERNAME"]
        values[f"SPX_DB_PASSWORD_{role}_FILE"] = db_password_path
    for node in NOTIFICATION_NODES:
        suffix = node.removeprefix("prod-").replace("-1", "").replace("-node2", "").replace("-", "_").upper()
        values[f"SPX_NOTIFICATION_NODE_SECRET_{suffix}_FILE"] = secret_path(root, f"notification-{node}")
        values[f"SPX_REALTIME_SHARED_SECRET_{suffix}_FILE"] = secret_path(root, f"realtime-{node}")
    values.update({
        "SPX_REALTIME_SHARED_SECRET_NOTIFIER_FILE": secret_path(root, "realtime-prod-notifier-1"),
        "SPX_REALTIME_SHARED_SECRET_WEB_API_FILE": secret_path(root, "realtime-prod-web-api-1"),
        "SPX_REALTIME_SHARED_SECRET_NOTIFICATION_SERVICE_FILE": secret_path(root, "realtime-prod-notification-service-1"),
    })
    for key in (
        "SPX_REALTIME_NOTIFIER_URL", "SPX_REALTIME_WEB_API_URL", "SPX_REALTIME_NOTIFICATION_SERVICE_URL",
        "SPX_REALTIME_WORKER_IFN_SPLIT_URL", "SPX_REALTIME_WORKER_PTWL_SPLIT_URL",
        "SPX_REALTIME_WORKER_IFN_URL", "SPX_REALTIME_WORKER_PTWL_URL",
        "SPX_REALTIME_POLLER_IFN_PHASE3_URL", "SPX_REALTIME_POLLER_PTWL_PHASE3_URL",
        "SPX_REALTIME_AUTO_ACCEPT_IFN_PHASE3_URL", "SPX_REALTIME_AUTO_ACCEPT_PTWL_PHASE3_URL",
    ):
        values[key] = ""
    write_runtime_env(root / "runtime.env", values)
    return {
        "unit": unit,
        "environmentFile": str(root / "runtime.env"),
        "notificationSecretFile": str(secret_path(root, "notification-prod-worker-ifn-node2")),
    }


def write_runtime_env(path, values):
    lines = [f"{key}={quote_env(values[key])}" for key in sorted(values)]
    atomic_write(path, ("\n".join(lines) + "\n").encode(), 0o400)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unit", required=True, choices=("primary", "team2"))
    parser.add_argument("--legacy-env", type=Path, default=Path("/root/SPX/.env"))
    parser.add_argument("--ca-source", type=Path, required=True)
    parser.add_argument("--root", type=Path, default=Path("/etc/spx-production"))
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise BootstrapError("production runtime bootstrap requires root")
    if args.root != Path("/etc/spx-production"):
        raise BootstrapError("production runtime root must be canonical")
    result = prepare_runtime(args.unit, args.legacy_env, args.ca_source, args.root)
    print(json.dumps({"ok": True, **result}, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = str(error) if isinstance(error, BootstrapError) else "production runtime bootstrap failed"
        print(message, file=os.sys.stderr)
        raise SystemExit(1)
