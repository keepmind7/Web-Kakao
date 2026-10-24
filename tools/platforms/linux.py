"""Linux launcher checks via procfs, without PATH searches or shell commands."""
import os
from pathlib import Path
import posixpath
import re
import stat


PROC_ROOT = Path("/proc")
_MAX_TABLE = 16 * 1024 * 1024
_MAX_LOG = 64 * 1024 * 1024
BROWSER_CANDIDATES = {
    "chrome": ("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"),
    "chromium": ("/usr/bin/chromium", "/usr/bin/chromium-browser"),
    "edge": ("/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"),
}


def _uid():
    value = os.getuid()
    if value != os.geteuid():
        raise OSError("launcher_effective_uid_mismatch")
    return value


def _read_table(path):
    with path.open("rb") as stream:
        data = stream.read(_MAX_TABLE + 1)
    if len(data) > _MAX_TABLE:
        raise OSError("listener_table_size")
    try:
        return data.decode("ascii").splitlines()
    except UnicodeError:
        raise OSError("listener_table_format") from None


def _listener_inodes(port, uid):
    if type(port) is not int or not 1 <= port <= 65535:
        raise OSError("listener_port")
    found = set()
    for name in ("tcp", "tcp6"):
        path = PROC_ROOT / "net" / name
        try:
            lines = _read_table(path)
        except FileNotFoundError:
            # IPv6 can be disabled at the kernel level; IPv4 is required.
            if name == "tcp6":
                continue
            raise OSError("listener_table_unavailable") from None
        if not lines or "local_address" not in lines[0] or "inode" not in lines[0]:
            raise OSError("listener_table_format")
        for line in lines[1:]:
            fields = line.split()
            if len(fields) < 10:
                raise OSError("listener_table_format")
            try:
                address, encoded_port = fields[1].rsplit(":", 1)
                if len(address) != (8 if name == "tcp" else 32) or not re.fullmatch(r"[0-9A-Fa-f]+", address):
                    raise ValueError
                local_port = int(encoded_port, 16)
                state = int(fields[3], 16)
                socket_uid = int(fields[7])
                inode = int(fields[9])
            except (ValueError, IndexError):
                raise OSError("listener_table_format") from None
            if state != 0x0A or local_port != port:
                continue
            if socket_uid != uid or inode <= 0:
                raise OSError("listener_owner_uid")
            found.add(inode)
    return found


def _process_uid(folder):
    info = folder.stat()
    if not stat.S_ISDIR(info.st_mode):
        raise OSError("process_directory")
    return info.st_uid


def listener_owners(port):
    """Resolve every matching LISTEN inode; unknown or denied same-UID FDs fail closed.

    Kernel socket UIDs must match the caller. Other-user proc directories are not
    readable on normal Linux installations and are skipped; an unresolved target
    inode is never interpreted as an empty/stale listener table.
    """
    uid = _uid()
    inodes = _listener_inodes(port, uid)
    if not inodes:
        return set()
    found, owners = set(), set()
    for folder in PROC_ROOT.iterdir():
        if not folder.name.isdecimal() or int(folder.name) <= 0:
            continue
        try:
            if _process_uid(folder) != uid:
                continue
            descriptors = list((folder / "fd").iterdir())
        except FileNotFoundError:
            # A process may exit while the proc table is enumerated.
            if not folder.exists():
                continue
            raise OSError("process_fds_unavailable") from None
        except OSError:
            raise OSError("process_fds_unavailable") from None
        for descriptor in descriptors:
            try:
                target = os.readlink(descriptor)
            except FileNotFoundError:
                continue  # Closed FD; missing target inodes still fail below.
            except OSError:
                raise OSError("process_fd_unavailable") from None
            match = re.fullmatch(r"socket:\[(\d+)\]", target)
            if match and int(match.group(1)) in inodes:
                found.add(int(match.group(1)))
                owners.add(int(folder.name))
    if found != inodes or _listener_inodes(port, uid) != inodes:
        raise OSError("listener_owners_unresolved")
    return owners


def assert_pid_listener(port, pid):
    """Verify the expected PID holds every matching LISTEN inode; not exclusivity.

    False means the table was empty. A nonempty table with missing ownership or
    inaccessible target state is an error, never a stale runtime. Other same-UID
    processes are outside this check; the local launcher assumes one trusted OS
    user and does not claim isolation from hostile same-UID processes/shared FDs.
    """
    if type(pid) is not int or pid <= 0:
        raise OSError("process_pid")
    uid = _uid()
    inodes = _listener_inodes(port, uid)
    if not inodes:
        return False
    folder = PROC_ROOT / str(pid)
    if _process_uid(folder) != uid:
        raise OSError("process_uid")
    try:
        descriptors = list((folder / "fd").iterdir())
    except OSError:
        raise OSError("process_fds_unavailable") from None
    found = set()
    for descriptor in descriptors:
        try:
            target = os.readlink(descriptor)
        except FileNotFoundError:
            continue  # Closed FDs cannot supply a missing LISTEN inode.
        except OSError:
            raise OSError("process_fd_unavailable") from None
        match = re.fullmatch(r"socket:\[(\d+)\]", target)
        if match and int(match[1]) in inodes:
            found.add(int(match[1]))
    if _process_uid(folder) != uid or _uid() != uid:
        raise OSError("process_uid")
    if found != inodes or _listener_inodes(port, uid) != inodes:
        raise OSError("target_listener_unresolved")
    return True


def process_image(pid):
    if type(pid) is not int or pid <= 0:
        raise OSError("process_pid")
    folder = PROC_ROOT / str(pid)
    uid = _uid()
    if _process_uid(folder) != uid:
        raise OSError("process_uid")
    image = os.readlink(folder / "exe")
    if not posixpath.isabs(image) or image.endswith(" (deleted)") or _process_uid(folder) != uid:
        raise OSError("process_image")
    return image


def spawn_options():
    return {"start_new_session": True, "umask": 0o077}


def open_log(path, verify):
    """Create logs private from the first byte, refusing links and changed inodes."""
    path = Path(path)
    verify(path, max_bytes=_MAX_LOG)
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open(path, flags, 0o600)
    try:
        info, current = os.fstat(descriptor), path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != _uid() or
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size > _MAX_LOG or
                (info.st_dev, info.st_ino) != (current.st_dev, current.st_ino)):
            raise ValueError("private_log_file")
        verify(path, max_bytes=_MAX_LOG)
        stream = os.fdopen(descriptor, "ab")
    except BaseException:
        os.close(descriptor)
        raise
    return stream


def _browser_executable(candidate):
    try:
        target = Path(candidate).resolve(strict=True)
        info = target.stat()
        if not stat.S_ISREG(info.st_mode) or not info.st_mode & 0o111 or not os.access(target, os.X_OK):
            return None
        # Reject writable launchers/ancestors rather than trusting a PATH entry.
        for item in (target, *target.parents):
            check = item.stat()
            if check.st_uid != 0 or check.st_mode & 0o022:
                return None
        return target
    except (OSError, RuntimeError):
        return None


def find_browser(name):
    names = ("chrome", "chromium", "edge") if name == "default" else (name,)
    for selected in names:
        for candidate in BROWSER_CANDIDATES.get(selected, ()):
            executable = _browser_executable(candidate)
            if executable is not None:
                return executable
    return None


def browser_environment(environ):
    allowed = {"HOME", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME",
               "DBUS_SESSION_BUS_ADDRESS", "LANG", "LC_ALL", "LC_CTYPE"}
    environment = {key: value for key, value in environ.items() if key in allowed}
    environment["PATH"] = "/usr/bin:/bin"
    return environment


def broad_write_warnings(root):
    found = []
    for path in [root, root / "local-only/runtime", root / "local-only/spikes", root / "experiments/local-web"]:
        try:
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022:
                found.append(path)
        except FileNotFoundError:
            continue
        except OSError:
            found.append(path)
    return found
