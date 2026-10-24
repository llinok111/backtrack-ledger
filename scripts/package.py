#!/usr/bin/env python3
"""Package the project into a distributable ZIP.

Includes built artifacts (dist/, demo bundle) so the archive runs immediately
after extraction; excludes development-only directories.
"""

import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(os.path.dirname(ROOT), "deliver-backtrack-ledger")
NAME = "backtrack-ledger-1.0.0"

EXCLUDE_DIRS = {".git", "node_modules", "shots", "coverage", "__pycache__"}

INCLUDE_FILES = [
    ".babelrc",
    ".editorconfig",
    ".eslintignore",
    ".eslintrc.json",
    ".gitignore",
    ".npmignore",
    ".prettierignore",
    ".prettierrc",
    "index.js",
    "LICENSE",
    "NOTICE",
    "README.md",
    "README.upstream.md",
    "package.json",
    "package-lock.json",
]

INCLUDE_DIRS = [
    "src",
    "bin",
    "scripts",
    "demo",
    "docs",
    "dist",
    ".github",
]


def add_file(zf, path, arcname):
    info = zipfile.ZipInfo(arcname)
    info.compress_type = zipfile.ZIP_DEFLATED
    with open(path, "rb") as handle:
        data = handle.read()
    info.file_size = len(data)
    # Preserve the executable bit for CLI entry points.
    mode = 0o755 if os.path.basename(path) in {"regexp-tree", "backtrack-ledger"} else 0o644
    info.external_attr = (0o100000 | mode) << 16
    zf.writestr(info, data)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    target = os.path.join(OUT_DIR, f"{NAME}.zip")

    count = 0
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name in INCLUDE_FILES:
            path = os.path.join(ROOT, name)
            if os.path.isfile(path):
                add_file(zf, path, f"{NAME}/{name}")
                count += 1

        for directory in INCLUDE_DIRS:
            base = os.path.join(ROOT, directory)
            if not os.path.isdir(base):
                continue
            for current, dirs, files in os.walk(base):
                dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS)
                for filename in sorted(files):
                    path = os.path.join(current, filename)
                    relative = os.path.relpath(path, ROOT).replace(os.sep, "/")
                    add_file(zf, path, f"{NAME}/{relative}")
                    count += 1

    size = os.path.getsize(target)
    print(f"{target}")
    print(f"{count} files, {size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
