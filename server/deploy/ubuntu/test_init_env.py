import base64
import hashlib
import json
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("init-env.py")


class DeploymentSecretsTest(unittest.TestCase):
    def test_generated_secrets_are_valid_private_and_stable(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            subprocess.run([sys.executable, str(SCRIPT), name], check=True, capture_output=True)
            env = root / ".env"
            values = dict(line.split("=", 1) for line in env.read_text().splitlines() if line and not line.startswith("#"))
            self.assertEqual(len(values["PI_BOT_ADMIN_PASSWORD"]), 32)
            self.assertEqual(len(values["POSTGRES_PASSWORD"]), 32)
            self.assertEqual(len(values["PI_BOT_JWT_SECRET"]), 64)
            self.assertEqual(len(values["PI_BOT_RUNNER_TOKEN"]), 64)
            self.assertEqual(len(base64.b64decode(values["PI_BOT_VAULT_KEY"])), 32)
            self.assertEqual(stat.S_IMODE(env.stat().st_mode), 0o600)
            vault = root / "vault.json"
            self.assertEqual(stat.S_IMODE(vault.stat().st_mode), 0o400)
            self.assertEqual(json.loads(vault.read_text())["keys"][values["PI_BOT_VAULT_KEY_ID"]], values["PI_BOT_VAULT_KEY"])
            original = [hashlib.sha256(file.read_bytes()).digest() for file in [env, vault]]
            subprocess.run([sys.executable, str(SCRIPT), name], check=True, capture_output=True)
            self.assertEqual(original, [hashlib.sha256(file.read_bytes()).digest() for file in [env, vault]])

    def test_existing_inconsistent_vault_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as name:
            subprocess.run([sys.executable, str(SCRIPT), name], check=True, capture_output=True)
            vault = Path(name) / "vault.json"
            vault.chmod(0o600)
            vault.write_text('{"active":"existing","keys":{}}')
            result = subprocess.run([sys.executable, str(SCRIPT), name], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"refusing to replace", result.stderr)
            self.assertEqual(vault.read_text(), '{"active":"existing","keys":{}}')


@unittest.skipUnless(shutil.which("docker"), "Docker Compose CLI is required")
class DeploymentComposeTest(unittest.TestCase):
    def test_runner_mount_and_public_ports_match_the_deployment_contract(self):
        with tempfile.TemporaryDirectory() as name:
            subprocess.run([sys.executable, str(SCRIPT), name], check=True, capture_output=True)
            result = subprocess.run([
                "docker", "compose", "--env-file", str(Path(name) / ".env"),
                "-f", str(SCRIPT.with_name("compose.yml")), "config", "--format", "json",
            ], check=True, capture_output=True)
            services = json.loads(result.stdout)["services"]
            self.assertEqual(services["runner"]["tmpfs"], ["/tmp:rw,nosuid,nodev"])
            self.assertTrue(services["runner"]["read_only"])
            self.assertEqual(services["api"]["ports"][0]["published"], "8000")
            for name in ["postgres", "runner", "worker", "searxng"]:
                self.assertFalse(services[name].get("ports"), f"{name} must stay internal")


if __name__ == "__main__":
    unittest.main()
