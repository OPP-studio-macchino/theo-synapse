#!/usr/bin/env python3
"""Owner-local, deny-by-default one-record native DIRECT identity reauthorization.

This is a recovery for the approved theo-acceptance test directory only.
It never changes a source file, a signed Core file, a daemon, or credentials.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import stat
import subprocess
import sys
import time
import uuid

HOME = Path.home()
BASE = HOME / "Library/Application Support/Theo Synapse"
CORE = BASE / "core"
APP = HOME / "Applications/Theo Synapse.app"
RUNTIME = CORE / ".local/theo-runtime"
REGISTRY = RUNTIME / "direct-workspaces.json"
SOURCE = HOME / "Documents/Theo-Synapse-Acceptance-20261029"
PROJECT_ID = "theo-acceptance"
EXPECTED_PROOF = b"export const VALUE = 2;\n"
os.umask(0o077)


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_safety(p, private=False):
    s = p.lstat()
    require(stat.S_ISREG(s.st_mode) and not p.is_symlink() and s.st_uid == os.getuid() and s.st_nlink == 1, "REPAIR_FILE_UNSAFE")
    if private:
        require(s.st_mode & 0o077 == 0, "REPAIR_PRIVATE_FILE_PERMISSIONS")
    return s


def dir_safety(p):
    s = p.lstat()
    require(stat.S_ISDIR(s.st_mode) and not p.is_symlink() and s.st_uid == os.getuid() and s.st_mode & 0o077 == 0, "REPAIR_PRIVATE_DIRECTORY_UNSAFE")


def current_fingerprint(p):
    s = p.lstat()
    require(stat.S_ISDIR(s.st_mode) and not p.is_symlink() and s.st_uid == os.getuid(), "REPAIR_SOURCE_UNSAFE")
    require(s.st_mode & 0o022 == 0 and p.resolve() == p, "REPAIR_SOURCE_ALIAS_OR_PERMISSIONS")
    facts = {"path": str(p), "dev": s.st_dev, "ino": s.st_ino, "uid": s.st_uid, "mode": s.st_mode & 0o777}
    return sha(json.dumps(facts, ensure_ascii=False, separators=(",", ":")).encode())


def no_active(dbpath, table, states):
    if not dbpath.exists():
        return
    file_safety(dbpath, private=True)
    try:
        connection = sqlite3.connect("file:" + str(dbpath) + "?mode=ro", uri=True, timeout=2)
        try:
            count = connection.execute("SELECT COUNT(*) FROM " + table + " WHERE state IN (" + states + ")").fetchone()[0]
        finally:
            connection.close()
    except sqlite3.Error:
        raise RuntimeError("REPAIR_TASK_JOURNAL_UNREADABLE")
    require(count == 0, "REPAIR_ACTIVE_TASKS_DENIED")


def verify_idle():
    require(sys.platform == "darwin", "REPAIR_MACOS_ONLY")
    with (APP / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    require(info.get("CFBundleShortVersionString") == "0.1.7" and info.get("CFBundleVersion") == "10", "REPAIR_UNEXPECTED_APP_VERSION")
    manager = APP / "Contents/MacOS/TheoSynapse"
    r = subprocess.run([str(manager), "--manage", "status"], capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=30)
    require(r.returncode == 0, "REPAIR_NATIVE_STATUS_UNAVAILABLE")
    try:
        s = json.loads(r.stdout)
    except ValueError:
        raise RuntimeError("REPAIR_NATIVE_STATUS_INVALID")
    require(all((s.get("hostState") == "READONLY(8)", s.get("mode") == "read_only", s.get("running") is True,
                 s.get("launchAgentLoaded") is True, s.get("readonlyLaunchAgentLoaded") is True,
                 s.get("directLaunchAgentLoaded") is False, s.get("activeTasks") == 0,
                 s.get("directActiveRuns") == 0, s.get("writeEnabled") is False)), "REPAIR_NATIVE_NOT_IDLE_READONLY")
    no_active(RUNTIME / "tasks.sqlite", "standalone_tasks", "'QUEUED','RUNNING','STOP_REQUESTED'")
    no_active(RUNTIME / "direct.sqlite", "direct_runs", "'APPROVAL_PENDING','QUEUED','RUNNING'")
    no_active(RUNTIME / "writes.sqlite", "theo_write_requests", "'APPROVAL_PENDING','AUTHORIZED','RUNNING'")


def plan(created=None):
    verify_idle()
    for directory in (BASE, CORE, CORE / ".local", RUNTIME):
        dir_safety(directory)
    file_safety(REGISTRY, private=True)
    raw = REGISTRY.read_bytes()
    require(len(raw) < 8192, "REPAIR_REGISTRY_TOO_LARGE")
    try:
        registry = json.loads(raw)
    except ValueError:
        raise RuntimeError("REPAIR_REGISTRY_INVALID")
    require(registry.get("schema") == 1 and list(registry) == ["schema", "workspaces"], "REPAIR_REGISTRY_INVALID")
    items = registry.get("workspaces")
    require(isinstance(items, dict) and list(items) == [PROJECT_ID], "REPAIR_UNEXPECTED_WORKSPACE_IDS")
    record = items[PROJECT_ID]
    require(isinstance(record, dict) and sorted(record) == ["fingerprint", "path"] and record["path"] == str(SOURCE), "REPAIR_UNEXPECTED_SOURCE")
    require(SOURCE.is_dir() and SOURCE.resolve() == SOURCE and SOURCE.parent == HOME / "Documents", "REPAIR_SOURCE_NOT_CANONICAL")
    require(sorted(p.name for p in SOURCE.iterdir()) == ["proof.js"], "REPAIR_SOURCE_CONTENTS_CHANGED")
    proof = SOURCE / "proof.js"
    file_safety(proof)
    require(proof.read_bytes() == EXPECTED_PROOF, "REPAIR_PROOF_CHANGED")
    fresh = current_fingerprint(SOURCE)
    saved = record["fingerprint"]
    require(isinstance(saved, str) and len(saved) == 64 and all(c in "0123456789abcdef" for c in saved), "REPAIR_STORED_FINGERPRINT_INVALID")
    require(fresh != saved, "REPAIR_ALREADY_VALID")
    now = int(time.time() * 1000) if created is None else created
    facts = {"id": PROJECT_ID, "saved": saved, "new": fresh, "registrySHA256": sha(raw),
             "proofSHA256": sha(EXPECTED_PROOF), "createdAt": now, "expiresAt": now + 300000}
    code = sha(json.dumps(facts, ensure_ascii=False, separators=(",", ":")).encode())[:20]
    return facts, code, registry


def native_approval(facts, code):
    lines = ["Theo Synapse: DIRECT登録の再認証",
             "対象: theo-acceptance (専用検証フォルダだけ)",
             "登録時の指紋: " + facts["saved"][:20],
             "現在の指紋: " + facts["new"][:20],
             "今回の確認コード: " + code,
             "既存のソースやタスク履歴は変更しません。",
             "このフォルダを新しい同一性として再認証しますか？",
             "別の書き込み作業には毎回あらためて許可が必要です。"]
    message = "\n".join(lines).replace("\\", "\\\\").replace('"', '\\"')
    apple = ('try\nset d to display dialog "' + message + '" with title "Theo Synapse DIRECT再認証" '
             'buttons {"許可しない", "今回だけ再認証を許可"} default button "許可しない" '
             'cancel button "許可しない" with icon caution giving up after 90\n'
             'if gave up of d then return "DENIED"\n'
             'if button returned of d is "今回だけ再認証を許可" then return "APPROVED"\n'
             'return "DENIED"\non error\nreturn "DENIED"\nend try')
    result = subprocess.run(["/usr/bin/osascript", "-e", apple], text=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=99)
    return result.returncode == 0 and result.stdout.strip() == "APPROVED"


def reauthorize():
    facts, code, _ = plan()
    print("REPAIR_PLAN", json.dumps({"id": facts["id"], "savedPrefix": facts["saved"][:20],
                                     "newPrefix": facts["new"][:20], "reviewCode": code}), flush=True)
    require(native_approval(facts, code), "REPAIR_OWNER_NOT_APPROVED")
    require(int(time.time() * 1000) <= facts["expiresAt"], "REPAIR_APPROVAL_EXPIRED")
    current, latest, record = plan(created=facts["createdAt"])
    require(current == facts and latest == code, "REPAIR_REVIEW_FINGERPRINT_CHANGED")
    audit_dir = BASE / "upgrade-audit"
    dir_safety(audit_dir)
    ident = uuid.uuid4().hex[:12]
    backup = audit_dir / ("native-direct-rebind-before-" + ident + ".json")
    original = REGISTRY.read_bytes()
    require(sha(original) == facts["registrySHA256"], "REPAIR_REGISTRY_RACE")
    # Preserve exact old ledger before atomic, separately approved update.
    with backup.open("xb") as stream:
        stream.write(original)
        stream.flush()
        os.fsync(stream.fileno())
    backup.chmod(0o600)
    record["workspaces"][PROJECT_ID]["fingerprint"] = facts["new"]
    target = json.dumps(record, ensure_ascii=False, indent=2).encode() + b"\n"
    tmp = RUNTIME / (".direct-workspaces-rebind-" + ident + ".tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(target)
            stream.flush()
            os.fsync(stream.fileno())
        require(sha(REGISTRY.read_bytes()) == facts["registrySHA256"], "REPAIR_REGISTRY_CHANGED_BEFORE_COMMIT")
        require(current_fingerprint(SOURCE) == facts["new"], "REPAIR_SOURCE_CHANGED_BEFORE_COMMIT")
        os.replace(tmp, REGISTRY)
        directory_fd = os.open(RUNTIME, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if tmp.exists():
            tmp.unlink()
    require(sha(REGISTRY.read_bytes()) == sha(target), "REPAIR_COMMIT_UNVERIFIED")
    print("REPAIR_OWNER_AUTHORIZED_REBIND_COMMITTED", json.dumps({"id": PROJECT_ID, "newPrefix": facts["new"][:20],
                                                                  "backupName": backup.name}), flush=True)


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 2 and sys.argv[1] in ("plan", "reauthorize"), "REPAIR_USAGE_DENIED")
        if sys.argv[1] == "plan":
            facts, code, _ = plan()
            print(json.dumps({"status": "READY_FOR_OWNER_REBIND", "id": facts["id"],
                              "oldPrefix": facts["saved"][:20], "newPrefix": facts["new"][:20],
                              "reviewCode": code, "expiresAt": facts["expiresAt"]}))
        else:
            reauthorize()
    except Exception as exc:
        value = str(exc)
        print("REPAIR_STOP", value if value.startswith("REPAIR_") else "REPAIR_UNVERIFIED_FAILURE", flush=True)
        sys.exit(1)
