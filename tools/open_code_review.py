"""Run the pinned project-local Alibaba OCR CLI without changing global settings.

Install once with --install; all other arguments are forwarded to OCR.
Delegation commands require no separate LLM credentials.
"""

from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import urllib.request
import zipfile

try:
    from tools.safe_download import checked_path, download_stage
    from tools.prepare_node_spike import _publish_directory
except ModuleNotFoundError:
    from safe_download import checked_path, download_stage
    from prepare_node_spike import _publish_directory


VERSION = "1.13.3"
ROOT = Path(__file__).resolve().parents[1]
INSTALL_DIR = ROOT / "local-only" / "tools" / "open-code-review" / f"v{VERSION}"
RELEASE = f"https://github.com/alibaba/open-code-review/releases/download/v{VERSION}"
WINDOWS_AMD64_SHA256 = "09bf6d1b8a24859fcc88f7bab1576a290a074f147655b860be4e766b568c3809"
MINGIT_VERSION = "2.56.0.4"
MINGIT_DIR = ROOT / "local-only" / "tools" / "mingit" / MINGIT_VERSION
MINGIT_SHA256 = "e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877"


def target() -> tuple[str, str]:
    systems = {"Windows": "windows", "Linux": "linux", "Darwin": "darwin"}
    architectures = {"amd64": "amd64", "x86_64": "amd64", "arm64": "arm64", "aarch64": "arm64"}
    system = systems.get(platform.system())
    architecture = architectures.get(platform.machine().lower())
    if not system or not architecture:
        raise ValueError("Unsupported platform for the pinned OCR release")
    extension = ".exe" if system == "windows" else ""
    return f"opencodereview-{system}-{architecture}{extension}", f"ocr{extension}"


def download(name: str) -> bytes:
    request = urllib.request.Request(f"{RELEASE}/{name}", headers={"User-Agent": "Web-Kakao-OCR-installer"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def install(asset: str, executable: Path) -> None:
    destination = checked_path(INSTALL_DIR)
    executable = checked_path(executable)
    if executable.parent != destination:
        raise ValueError("OCR executable must be inside the installation directory")
    if destination.exists():
        raise FileExistsError("Existing OCR installation preserved")
    checksums = download("sha256sum.txt")
    expected = next((row.split()[0] for row in checksums.decode("utf-8").splitlines()
                     if len(row.split()) == 2 and row.split()[1].lstrip("*") == asset), None)
    if not expected:
        raise ValueError("Official checksum entry missing")
    if asset == "opencodereview-windows-amd64.exe" and expected != WINDOWS_AMD64_SHA256:
        raise ValueError("Published checksum differs from the pinned Windows checksum")
    content = download(asset)
    if hashlib.sha256(content).hexdigest() != expected:
        raise ValueError("Downloaded OCR checksum mismatch")
    with download_stage(destination.parent) as stage:
        home = stage / "install"
        home.mkdir()
        temporary = home / executable.name
        with temporary.open("xb") as output:
            output.write(content)
        temporary.chmod(0o700)
        with (home / "sha256sum.txt").open("xb") as output:
            output.write(checksums)
        _publish_directory(home, checked_path(destination))
    print(f"Installed OCR {VERSION}; SHA-256 verified: {expected}")


def install_git() -> None:
    destination = checked_path(MINGIT_DIR)
    if destination.exists():
        raise FileExistsError("Existing MinGit installation preserved")
    url = ("https://github.com/git-for-windows/git/releases/download/"
           f"v2.56.0.windows.4/MinGit-{MINGIT_VERSION}-64-bit.zip")
    with urllib.request.urlopen(url, timeout=90) as response:
        content = response.read()
    if hashlib.sha256(content).hexdigest() != MINGIT_SHA256:
        raise ValueError("MinGit checksum mismatch")
    with zipfile.ZipFile(io.BytesIO(content)) as archive, download_stage(destination.parent) as stage:
        home = stage / "install"
        home.mkdir()
        for entry in archive.infolist():
            name = entry.orig_filename
            parts = name.rstrip("/").split("/")
            if (name != entry.filename or "\\" in name or name.startswith("/")
                    or any(part in {"", ".", ".."} for part in parts)
                    or stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG, stat.S_IFDIR)):
                raise ValueError("Unsafe MinGit archive entry")
            target = checked_path(home.joinpath(*parts))
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
        if not (home / "cmd" / "git.exe").is_file():
            raise ValueError("MinGit executable missing")
        _publish_directory(home, checked_path(destination))
    print(f"Installed project-local MinGit {MINGIT_VERSION}; SHA-256 verified")


def main() -> int:
    arguments = sys.argv[1:]
    if not arguments or arguments == ["--launcher-help"]:
        print("Usage: python tools/open_code_review.py --install")
        print("       python tools/open_code_review.py delegate preview --format json")
        print("       python tools/open_code_review.py delegate rule --format json <paths...>")
        print("Other arguments are forwarded to the pinned OCR CLI. Default cwd is this project.")
        return 0
    try:
        asset, name = target()
        executable = checked_path(INSTALL_DIR / name)
        if arguments == ["--install"]:
            install(asset, executable)
            if asset == "opencodereview-windows-amd64.exe":
                install_git()
            return 0
        if not executable.is_file():
            print("OCR is not installed. Run: python tools/open_code_review.py --install", file=sys.stderr)
            return 1
        environment = os.environ.copy()
        git_directory = MINGIT_DIR / "cmd"
        if os.name == "nt" and checked_path(git_directory / "git.exe").is_file():
            environment["PATH"] = str(git_directory) + os.pathsep + environment.get("PATH", "")
        return subprocess.run([str(executable), *arguments], cwd=ROOT,
                              env=environment, check=False).returncode
    except (OSError, ValueError) as error:
        print(f"OCR launcher: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
