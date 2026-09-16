import importlib.util
import os
from pathlib import Path
import re
import tempfile


MODULE_PATH = Path("scripts/a3-production-runtime-bootstrap.py").resolve()
SPEC = importlib.util.spec_from_file_location("a3_production_runtime_bootstrap", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def parse_env(path):
    result = {}
    for line in Path(path).read_text(encoding="utf8").splitlines():
        key, value = line.split("=", 1)
        result[key] = value.strip('"')
    return result


def fake_key_pair(private_path, public_path):
    MODULE.atomic_write(private_path, b"private-test-key", 0o400)
    MODULE.atomic_write(public_path, b"-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n", 0o444)


def main():
    MODULE.ensure_ed25519_pair = fake_key_pair
    with tempfile.TemporaryDirectory(prefix="spx-runtime-bootstrap-") as temporary:
        temporary = Path(temporary)
        legacy = temporary / "legacy.env"
        legacy.write_text(
            "DB_USERNAME=legacy_user\n"
            "DB_PASSWORD='legacy-password-value'\n"
            "DB_NAME=SPX\n"
            "SECRETS_KEY=legacy-secrets-key-that-is-long-enough\n",
            encoding="utf8",
        )
        ca = temporary / "ca.pem"
        ca.write_text("-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n", encoding="utf8")

        primary_root = temporary / "primary"
        first = MODULE.prepare_runtime("primary", legacy, ca, primary_root)
        environment = parse_env(first["environmentFile"])
        source = Path("docker-compose.a3.yml").read_text(encoding="utf8")
        required = set(re.findall(r"\$\{(SPX_[A-Z0-9_]+):\?", source))
        injected = {
            "SPX_IMAGE", "SPX_RELEASE_SHA", "SPX_TARGET_DESCRIPTOR_SHA256",
            "SPX_OPERATOR_BUNDLE_SHA256", "SPX_RELEASE_MANIFEST_PATH",
            "SPX_TARGET_DESCRIPTOR_PATH", "SPX_DEPLOYMENT_CONTEXT_PATH",
        }
        missing = sorted(required - injected - environment.keys())
        assert missing == [], f"runtime bootstrap is missing required Compose variables: {missing}"
        missing_files = sorted(
            key for key, value in environment.items()
            if key.endswith("_FILE") and not Path(value).is_file()
        )
        assert missing_files == [], f"runtime bootstrap references missing files: {missing_files}"
        assert "legacy-password-value" not in Path(first["environmentFile"]).read_text(encoding="utf8")
        assert "legacy-secrets-key-that-is-long-enough" not in Path(first["environmentFile"]).read_text(encoding="utf8")
        assert (primary_root / "secrets" / "db-password-legacy").read_text() == "legacy-password-value"
        assert (primary_root / "secrets" / "secrets-key").read_text() == "legacy-secrets-key-that-is-long-enough"
        assert environment["SPX_DB_HOST"] == MODULE.PRIMARY_HOST

        notification_map = {}
        for pair in (primary_root / "secrets" / "notification-node-secrets").read_text().split(","):
            node, value = pair.split("=", 1)
            notification_map[node] = value
        assert notification_map.keys() == MODULE.NOTIFICATION_NODES.keys()
        assert len(set(notification_map.values())) == len(notification_map)
        team2_secret = Path(first["notificationSecretFile"]).read_text()
        assert notification_map["prod-worker-ifn-node2"] == team2_secret

        jwt_before = (primary_root / "secrets" / "jwt").read_bytes()
        second = MODULE.prepare_runtime("primary", legacy, ca, primary_root)
        assert second["environmentFile"] == first["environmentFile"]
        assert (primary_root / "secrets" / "jwt").read_bytes() == jwt_before

        unsafe_secret = primary_root / "secrets" / "jwt"
        unsafe_secret.chmod(0o600)
        replacement = primary_root / "secrets" / "jwt-hardlink"
        try:
            os.link(unsafe_secret, replacement)
        except OSError:
            pass
        else:
            try:
                MODULE.prepare_runtime("primary", legacy, ca, primary_root)
                raise AssertionError("hard-linked runtime secret was accepted")
            except MODULE.BootstrapError:
                pass
            replacement.unlink()

        team2_root = temporary / "team2"
        team2 = MODULE.prepare_runtime("team2", legacy, ca, team2_root)
        team2_env = parse_env(team2["environmentFile"])
        assert team2_env["SPX_DB_HOST"] == MODULE.TEAM2_HOST
        assert team2_env["SPX_DB_SSL_SERVERNAME"] == MODULE.PRIMARY_HOST
        assert "legacy-password-value" not in Path(team2["environmentFile"]).read_text(encoding="utf8")

        unsafe_root = temporary / "unsafe"
        unsafe_target = temporary / "unsafe-target"
        unsafe_target.mkdir()
        try:
            unsafe_root.symlink_to(unsafe_target, target_is_directory=True)
        except OSError:
            pass
        else:
            try:
                MODULE.prepare_runtime("primary", legacy, ca, unsafe_root)
                raise AssertionError("symlink runtime root was accepted")
            except MODULE.BootstrapError:
                pass

        if os.name == "posix":
            mode = os.stat(primary_root / "runtime.env").st_mode & 0o777
            assert mode == 0o400


if __name__ == "__main__":
    main()
    print("a3 production runtime bootstrap tests passed")
