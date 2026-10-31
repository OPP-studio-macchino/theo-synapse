#!/usr/bin/env python3
"""Prepare a reversible Theo Synapse icon-only update candidate. Never uploads."""
import hashlib
import json
import os
from pathlib import Path
from shutil import copy2
import struct
import sys
import zipfile

ROOT = Path("/Users/THEO_PUBLIC_EXAMPLE/Documents/Codex/ChatGPT-to-Codex-Standalone-20261026")
SOURCE = Path("/Users/THEO_PUBLIC_EXAMPLE/Downloads/plugin.zip")
ICON = ROOT / "assets/theo-synapse-icon.png"
WORK = ROOT / ".local/icon-update-20261027"
ORIGINAL = WORK / "original-theo-synapse-plugin.zip"
CANDIDATE = WORK / "theo-synapse-icon-v1.0.1.zip"
REPORT = WORK / "candidate-verification.json"
EXPECTED_ID = "asdk_app_6adfedb706388191bbcdad8b30e8b787"
EXPECTED_NAME = "dev-6adfedb706388191bbcdad8b30e8b787"
REQUIRED = {".app.json", ".codex-plugin/plugin.json"}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def require(condition, code):
    if not condition:
        raise RuntimeError(code)

def main():
    os.umask(0o077)
    require(ROOT.is_dir() and (ROOT.stat().st_mode & 0o077) == 0, "UNSAFE_PROJECT")
    require(SOURCE.is_file(), "ORIGINAL_PLUGIN_ZIP_MISSING")
    require(ICON.is_file(), "ICON_MISSING")
    require(not WORK.is_symlink(), "WORK_SYMLINK_NOT_ALLOWED")
    WORK.mkdir(mode=0o700, exist_ok=True)
    require((WORK.stat().st_mode & 0o077) == 0, "UNSAFE_WORK_DIR")
    require(not CANDIDATE.exists(), "CANDIDATE_ALREADY_EXISTS")
    require(not REPORT.exists(), "REPORT_ALREADY_EXISTS")

    icon = ICON.read_bytes()
    require(icon[:8] == b"\x89PNG\r\n\x1a\n", "INVALID_ICON_TYPE")
    width, height = struct.unpack(">II", icon[16:24])
    require(width == height and width >= 256 and len(icon) <= 5*1024*1024, "INVALID_ICON_DIMENSIONS")
    with zipfile.ZipFile(SOURCE) as z:
        names = z.namelist()
        require(set(names) == REQUIRED and len(names) == 2, "UNEXPECTED_ZIP_CONTENT")
        original_app_raw = z.read(".app.json")
        original_manifest_raw = z.read(".codex-plugin/plugin.json")
        app = json.loads(original_app_raw)
        manifest = json.loads(original_manifest_raw)
        require(manifest.get("name") == EXPECTED_NAME, "PLUGIN_IDENTITY_MISMATCH")
        require(manifest.get("apps") == "./.app.json", "APP_LINK_MISMATCH")
        require(manifest.get("version") == "1.0.0", "UNEXPECTED_BASE_VERSION")
        require(manifest.get("interface",{}).get("displayName") == "Theo Synapse", "DISPLAY_NAME_MISMATCH")
        require(app == {"apps": {EXPECTED_NAME: {"id": EXPECTED_ID}}}, "MCP_APP_ID_MISMATCH")

    # Keep the plugin and registered MCP app identities byte-for-byte identical.
    updated = json.loads(original_manifest_raw)
    updated["version"] = "1.0.1"
    updated["interface"]["composerIcon"] = "./assets/theo-synapse-icon.png"
    updated["interface"]["logo"] = "./assets/theo-synapse-icon.png"
    encoded = (json.dumps(updated, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    contents = {
        ".app.json": original_app_raw,
        ".codex-plugin/plugin.json": encoded,
        "assets/theo-synapse-icon.png": icon
    }
    # Keep the original ZIP as an immutable local backup.
    require(not ORIGINAL.exists(), "ORIGINAL_BACKUP_ALREADY_EXISTS")
    copy2(SOURCE, ORIGINAL)
    os.chmod(ORIGINAL, 0o600)
    with zipfile.ZipFile(CANDIDATE, mode="x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, data in contents.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 27, 9, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    os.chmod(CANDIDATE, 0o600)
    with zipfile.ZipFile(CANDIDATE) as z:
        require(z.testzip() is None, "CANDIDATE_ZIP_INTEGRITY_FAIL")
        require(set(z.namelist()) == set(contents), "CANDIDATE_FILE_LIST_MISMATCH")
        candidate_app_raw = z.read(".app.json")
        new_manifest = json.loads(z.read(".codex-plugin/plugin.json"))
        require(candidate_app_raw == original_app_raw, "REGISTERED_APP_MAPPING_CHANGED")
        require(new_manifest["name"] == manifest["name"], "PLUGIN_NAME_CHANGED")
        require(new_manifest["apps"] == manifest["apps"], "APP_REFERENCE_CHANGED")
        require(new_manifest["interface"]["displayName"] == manifest["interface"]["displayName"], "DISPLAY_NAME_CHANGED")
        require(z.read("assets/theo-synapse-icon.png") == icon, "ICON_MISMATCH")
        orig_excluding_version = json.loads(original_manifest_raw)
        candidate_excluding_version = json.loads(z.read(".codex-plugin/plugin.json"))
        orig_excluding_version.pop("version")
        candidate_excluding_version.pop("version")
        candidate_excluding_version["interface"].pop("logo")
        candidate_excluding_version["interface"].pop("composerIcon")
        require(orig_excluding_version == candidate_excluding_version, "UNAUTHORIZED_MANIFEST_CHANGE")
    report = {
        "status": "CANDIDATE_ONLY_NOT_UPLOADED",
        "source_plugin_sha256": sha(SOURCE.read_bytes()),
        "backup_sha256": sha(ORIGINAL.read_bytes()),
        "candidate_sha256": sha(CANDIDATE.read_bytes()),
        "app_mapping_bytes_unchanged": True,
        "stable_plugin_name": EXPECTED_NAME,
        "stable_registered_mcp_app_id": EXPECTED_ID,
        "name": "Theo Synapse",
        "previous_version": "1.0.0",
        "candidate_version": "1.0.1",
        "icon_size": [width, height],
        "icon_sha256": sha(icon),
        "new_fields": ["interface.logo", "interface.composerIcon"],
        "zip_members": sorted(contents)
    }
    require(report["source_plugin_sha256"] == report["backup_sha256"], "ORIGINAL_ZIP_BACKUP_MISMATCH")
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    os.chmod(REPORT, 0o600)
    print("ICON_PLUGIN_CANDIDATE_READY")
    print("CANDIDATE_NOT_UPLOADED")
    print("REGISTERED_APP_MAPPING_UNCHANGED")
    print("VERSION_UPGRADE", report["previous_version"], "=>", report["candidate_version"])
    print("CANDIDATE_PATH", CANDIDATE)
    print("CANDIDATE_BYTES", CANDIDATE.stat().st_size)
    print("ICON_DIMENSIONS", width, height)
    print("BACKUP_VERIFIED", True)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("ICON_UPDATE_PREPARATION_FAILED", str(e))
        sys.exit(1)
