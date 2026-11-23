#!/usr/bin/env python3
"""Verify regular-file release archives; extract only after the same validation.

No shell, service, provider, database or customer-data operation is performed.
"""
import hashlib
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tarfile
import tempfile
import time


def merge_apps_root(file, request, enable=False):
    path = Path(file)
    fd = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "a") as lock:
        until = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= until:
                    raise ValueError("studio.json is busy; no field was changed.")
                time.sleep(0.04)
        before = path.read_bytes() if path.exists() else None
        data = json.loads(before) if before is not None else request.get("initial")
        if not isinstance(data, dict) or data.get("appsRoot") != request["expected"]:
            raise ValueError("appsRoot changed after planning; no field was changed.")
        if enable:
            apps = data.get("apps", [])
            if not isinstance(apps, list):
                raise ValueError("apps is not a list; no field was changed.")
            data["apps"] = apps if request["app"] in apps else [*apps, request["app"]]
        else:
            data["appsRoot"] = request["value"]
        fd, tmp = tempfile.mkstemp(prefix=".studio-release-config-", dir=path.parent)
        try:
            os.fchmod(fd, stat.S_IMODE(path.stat().st_mode) if before is not None else 0o600)
            with os.fdopen(fd, "w") as out:
                json.dump(data, out, ensure_ascii=False, indent=2)
                out.write("\n")
                out.flush()
                os.fsync(out.fileno())
            if (path.read_bytes() if path.exists() else None) != before:
                raise ValueError("studio.json changed concurrently; no field was changed.")
            os.replace(tmp, path)
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        return {"field": "apps" if enable else "appsRoot", "changed": True, "apps": len(data.get("apps", []))}


def artifact(archive, baseline, destination=None):
    files, modes = {}, {}
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        names = set()
        for member in members:
            p = PurePosixPath(member.name)
            if p.is_absolute() or ".." in p.parts or "\\" in member.name or not p.parts:
                raise ValueError("Archive path leaves its component.")
            if member.name in names:
                raise ValueError("Duplicate archive entry.")
            names.add(member.name)
            if member.isdir():
                continue
            if not member.isfile() or member.name not in baseline:
                raise ValueError("Archive has a link, special or undeclared file.")
            digest = hashlib.sha256()
            with tar.extractfile(member) as content:
                while chunk := content.read(1024 * 1024):
                    digest.update(chunk)
            if digest.hexdigest() != baseline[member.name]:
                raise ValueError("Archive differs from the vendor baseline: " + member.name)
            files[member.name] = digest.hexdigest()
            modes[member.name] = member.mode & 0o777
        if set(files) != set(baseline):
            raise ValueError("Archive is missing vendor baseline files.")
        if destination:
            root = Path(destination)
            root.mkdir(parents=True, exist_ok=False)
            for member in members:
                if not member.isfile():
                    continue
                p = root / member.name
                p.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(member) as content, p.open("wb") as out:
                    while chunk := content.read(1024 * 1024):
                        out.write(chunk)
                    out.flush()
                    os.fsync(out.fileno())
                p.chmod(modes[member.name])
    return {"files": files, "modes": modes}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        result = merge_apps_root(sys.argv[2], request, sys.argv[1] == "--enable-app") if sys.argv[1] in ["--apps-root", "--enable-app"] else artifact(sys.argv[1], request["baseline"], request.get("destination"))
        print(json.dumps(result))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
