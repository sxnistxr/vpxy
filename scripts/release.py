#!/usr/bin/env python3
"""Build self-contained VPXY release archives and their SHA-256 manifest."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TARGETS = (
    "linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64",
    "windows-amd64", "windows-arm64",
)


def command(*args, env=None):
    return subprocess.check_output(args, cwd=ROOT, env=env, text=True).strip()


def build(args):
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", args.version):
        raise ValueError("Use a version such as v0.1.0 or v0.2.0-beta.1")
    goos, goarch = args.target.split("-")
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    commit = command("git", "rev-parse", "HEAD")
    date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    env = {**os.environ, "GOOS": goos, "GOARCH": goarch, "CGO_ENABLED": "0" if args.portable else "1"}
    binary = "vpxy.exe" if goos == "windows" else "vpxy"
    suffix = "_portable" if args.portable else ""
    name = f"vpxy_{args.version}_{goos}_{goarch}{suffix}"
    with tempfile.TemporaryDirectory(prefix=".vpxy-build-", dir=output) as temp:
        staging = Path(temp)
        flags = f"-s -w -X main.Version={args.version} -X main.Commit={commit} -X main.BuildDate={date}"
        subprocess.run(
            ["go", "build", "-trimpath", "-buildvcs=false", "-ldflags", flags, "-o", str(staging / binary), "./cmd/server"],
            cwd=ROOT, env=env, check=True,
        )
        metadata = command("go", "version", "-m", str(staging / binary))
        for expected in (f"GOOS={goos}", f"GOARCH={goarch}", f"CGO_ENABLED={env['CGO_ENABLED']}"):
            if expected not in metadata:
                raise RuntimeError(f"Executable metadata is missing {expected}")
        if args.smoke:
            host = json.loads(command("go", "env", "-json", "GOHOSTOS", "GOHOSTARCH"))
            if (host["GOHOSTOS"], host["GOHOSTARCH"]) != (goos, goarch):
                raise ValueError("--smoke requires a build for this runner's OS and architecture")
            result = subprocess.run([str(staging / binary), "--help"], cwd=staging, capture_output=True, text=True, check=True)
            if args.version not in result.stdout + result.stderr:
                raise RuntimeError("The executable did not report the release version")
            print(f"Smoke check passed: {args.target} {args.version}", flush=True)
        for source, destination in (
            ("LICENSE", "LICENSE"), ("README.md", "README.md"),
            ("config.vpxy.example.yaml", "config.example.yaml"),
            ("config.example.yaml", "config.reference.yaml"),
            (".env.example", ".env.example"),
            ("assets/logo/vibeproxy-wordmark.svg", "assets/logo/vibeproxy-wordmark.svg"),
            ("assets/logo/vibeproxy-wordmark-white.svg", "assets/logo/vibeproxy-wordmark-white.svg"),
        ):
            destination = staging / destination
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / source, destination)
        for source in (ROOT / "docs").glob("*.md"):
            if source.name == "VPXY_PLAN.md":
                continue
            destination = staging / "docs" / source.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        for directory in ("assets/screenshots", "assets/brand"):
            if (ROOT / directory).is_dir():
                shutil.copytree(ROOT / directory, staging / directory)
        (staging / "build-info.json").write_text(json.dumps({
            "version": args.version, "commit": commit, "built_at": date,
            "os": goos, "architecture": goarch,
            "cgo": env["CGO_ENABLED"] == "1", "portable": args.portable,
            "go_version": command("go", "version"),
        }, indent=2) + "\n", encoding="utf-8")
        members = sorted(path for path in staging.rglob("*") if path.is_file())
        if goos == "windows":
            archive = output / f"{name}.zip"
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as writer:
                for member in members:
                    writer.write(member, member.relative_to(staging).as_posix())
            with zipfile.ZipFile(archive) as reader:
                if reader.testzip() is not None or binary not in reader.namelist():
                    raise RuntimeError("Release ZIP verification failed")
        else:
            archive = output / f"{name}.tar.gz"
            with tarfile.open(archive, "w:gz") as writer:
                for member in members:
                    writer.add(member, arcname=member.relative_to(staging).as_posix())
            with tarfile.open(archive, "r:gz") as reader:
                executable = reader.getmember(binary)
                if not executable.mode & 0o111:
                    raise RuntimeError("The archived executable is not executable")
        print(f"Built and verified {archive.name} ({archive.stat().st_size:,} bytes)", flush=True)


def checksums(args):
    output = Path(args.output).resolve()
    archives = sorted([*output.glob("vpxy_*.zip"), *output.glob("vpxy_*.tar.gz")])
    if not archives:
        raise ValueError("No VPXY release archives found")
    if args.require_all:
        for target in TARGETS:
            goos, goarch = target.split("-")
            if not any(f"_{goos}_{goarch}." in path.name for path in archives):
                raise ValueError(f"Missing native release archive: {target}")
    lines = []
    for archive in archives:
        with archive.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        lines.append(f"{digest}  {archive.name}\n")
    (output / "checksums.txt").write_text("".join(lines), encoding="utf-8")
    print(f"Wrote checksums for {len(archives)} archives", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    builder = subcommands.add_parser("build")
    builder.add_argument("--version", required=True)
    builder.add_argument("--target", choices=TARGETS, required=True)
    builder.add_argument("--output", default=str(ROOT / "dist" / "release"))
    builder.add_argument("--portable", action="store_true", help="Build without CGO; Unix dynamic plugins are unavailable")
    builder.add_argument("--smoke", action="store_true")
    builder.set_defaults(func=build)
    checksum = subcommands.add_parser("checksums")
    checksum.add_argument("--output", default=str(ROOT / "dist" / "release"))
    checksum.add_argument("--require-all", action="store_true")
    checksum.set_defaults(func=checksums)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
