"""Synthetic-only Owner identity-rebind tests. No live Mac dialog or registry writes."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/reauthorize-native-direct-test-workspace-v017.py"


def load_module():
    spec = importlib.util.spec_from_file_location("native_direct_rebind_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NativeIdentityRebindTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="theo-direct-rebind-synthetic-", dir="/private/tmp")
        self.addCleanup(self.temp.cleanup)
        self.m = load_module()
        h = Path(self.temp.name)
        m = self.m
        m.HOME = h
        m.BASE = h / "Library/Application Support/Theo Synapse"
        m.CORE = m.BASE / "core"
        m.RUNTIME = m.CORE / ".local/theo-runtime"
        m.REGISTRY = m.RUNTIME / "direct-workspaces.json"
        m.SOURCE = h / "Documents/Theo-Synapse-Acceptance-20261029"
        m.APP = h / "Applications/Theo Synapse.app"
        m.verify_idle = lambda: None  # Synthetic only; real function remains fail-closed.
        for folder in (m.BASE, m.CORE, m.CORE / ".local", m.RUNTIME,
                       m.BASE / "upgrade-audit", m.SOURCE):
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            folder.chmod(0o700)
        self.proof = m.SOURCE / "proof.js"
        self.proof.write_bytes(m.EXPECTED_PROOF)
        self.proof.chmod(0o600)
        self.raw = (json.dumps({"schema": 1, "workspaces": {
            "theo-acceptance": {"path": str(m.SOURCE), "fingerprint": "b" * 64}
        }}, indent=2) + "\n").encode()
        m.REGISTRY.write_bytes(self.raw)
        m.REGISTRY.chmod(0o600)

    def test_review_plan_is_read_only_and_binds_changed_identity(self):
        before = self.m.REGISTRY.read_bytes()
        facts, code, _ = self.m.plan()
        self.assertNotEqual(facts["new"], facts["saved"])
        self.assertEqual(facts["registrySHA256"], self.m.sha(before))
        self.assertEqual(len(code), 20)
        self.assertEqual(self.m.REGISTRY.read_bytes(), before)

    def test_denial_keeps_old_registry_and_source(self):
        self.m.native_approval = lambda facts, code: False
        with self.assertRaisesRegex(RuntimeError, "REPAIR_OWNER_NOT_APPROVED"):
            self.m.reauthorize()
        self.assertEqual(self.m.REGISTRY.read_bytes(), self.raw)
        self.assertEqual(self.proof.read_bytes(), self.m.EXPECTED_PROOF)
        self.assertEqual(list((self.m.BASE / "upgrade-audit").iterdir()), [])

    def test_approved_synthetic_rebind_changes_only_one_fingerprint(self):
        self.m.native_approval = lambda facts, code: True
        self.m.reauthorize()
        new = json.loads(self.m.REGISTRY.read_bytes())
        self.assertEqual(list(new["workspaces"]), ["theo-acceptance"])
        self.assertEqual(new["workspaces"]["theo-acceptance"]["path"], str(self.m.SOURCE))
        self.assertEqual(new["workspaces"]["theo-acceptance"]["fingerprint"],
                         self.m.current_fingerprint(self.m.SOURCE))
        self.assertEqual(self.proof.read_bytes(), self.m.EXPECTED_PROOF)
        backups = list((self.m.BASE / "upgrade-audit").iterdir())
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), self.raw)
        self.assertEqual(self.m.REGISTRY.stat().st_mode & 0o777, 0o600)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)

    def test_source_change_during_approval_rejects_without_commit(self):
        def tamper(_facts, _code):
            self.proof.write_text("changed\n")
            return True
        self.m.native_approval = tamper
        with self.assertRaisesRegex(RuntimeError, "REPAIR_PROOF_CHANGED"):
            self.m.reauthorize()
        self.assertEqual(self.m.REGISTRY.read_bytes(), self.raw)

    def test_unexpected_registry_id_and_extra_source_file_both_rejected(self):
        extra = self.m.SOURCE / "extra.txt"
        extra.write_text("other")
        with self.assertRaisesRegex(RuntimeError, "REPAIR_SOURCE_CONTENTS_CHANGED"):
            self.m.plan()
        extra.unlink()
        malformed = json.loads(self.raw)
        malformed["workspaces"]["rogue"] = {"path": str(self.m.SOURCE), "fingerprint": "c" * 64}
        self.m.REGISTRY.write_text(json.dumps(malformed))
        with self.assertRaisesRegex(RuntimeError, "REPAIR_UNEXPECTED_WORKSPACE_IDS"):
            self.m.plan()


if __name__ == "__main__":
    unittest.main()
