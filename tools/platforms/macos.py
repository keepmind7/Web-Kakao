"""macOS launcher checks via lsof and libproc, without PATH searches or shell commands."""
import ctypes
import os
from pathlib import Path
import posixpath
import stat
import subprocess

try:
    from tools.platforms.linux import open_log, spawn_options, broad_write_warnings  # noqa: F401 (POSIX-generic)
except ModuleNotFoundError:
    from platforms.linux import open_log, spawn_options, broad_write_warnings  # noqa: F401

LSOF = "/usr/sbin/lsof"
LIBPROC = "/usr/lib/libproc.dylib"
_PIDPATH_MAX = 4096  # PROC_PIDPATHINFO_MAXSIZE
BROWSER_APPS = {
    "chrome": "Google Chrome.app/Contents/MacOS/Google Chrome",
    "chromium": "Chromium.app/Contents/MacOS/Chromium",
    "edge": "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
}


def listener_owners(port):
    """PIDs holding a TCP LISTEN socket on port; any other OS user fails closed.

    lsof cannot read other users' descriptors without root, so a foreign
    listener appears as an empty set and is then refused by the port probe.
    """
    if type(port) is not int or not 1 <= port <= 65535:
        raise OSError("listener_port")
    result = subprocess.run([LSOF, "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-Fpu"],
                            capture_output=True, timeout=10, env={"PATH": "/usr/bin:/bin"})
    if result.returncode not in (0, 1) or result.returncode == 1 and result.stdout.strip():
        raise OSError("listener_table_unavailable")
    owners, uid = set(), os.getuid()
    for line in result.stdout.decode("ascii", "strict").splitlines():
        if line.startswith("p"):
            owners.add(int(line[1:]))
        elif line.startswith("u") and int(line[1:]) != uid:
            raise OSError("listener_owner_uid")
    return owners


def process_image(pid):
    if type(pid) is not int or pid <= 0:
        raise OSError("process_pid")
    library = ctypes.CDLL(LIBPROC, use_errno=True)
    buffer = ctypes.create_string_buffer(_PIDPATH_MAX)
    if library.proc_pidpath(pid, buffer, _PIDPATH_MAX) <= 0:
        raise OSError("process_image")
    image = os.fsdecode(buffer.value)
    if not posixpath.isabs(image):
        raise OSError("process_image")
    return image


def _browser_executable(candidate):
    try:
        target = Path(candidate).resolve(strict=True)
        info = target.stat()
        if not stat.S_ISREG(info.st_mode) or not os.access(target, os.X_OK):
            return None
        # Drag-installed apps are user/admin owned and group-writable by admin;
        # reject only world-writable launchers or ancestors.
        if any(item.stat().st_mode & 0o002 for item in (target, *target.parents)):
            return None
        return target
    except (OSError, RuntimeError):
        return None


def find_browser(name):
    names = ("chrome", "chromium", "edge") if name == "default" else (name,)
    roots = [Path("/Applications")]
    home = os.environ.get("HOME")
    if home and posixpath.isabs(home):
        roots.append(Path(home) / "Applications")
    for selected in names:
        if selected not in BROWSER_APPS:
            continue
        for root in roots:
            executable = _browser_executable(root / BROWSER_APPS[selected])
            if executable is not None:
                return executable
    return None


def browser_environment(environ):
    allowed = {"HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE"}
    environment = {key: value for key, value in environ.items() if key in allowed}
    environment["PATH"] = "/usr/bin:/bin"
    return environment
