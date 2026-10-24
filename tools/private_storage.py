"""Private installation paths and explicitly invoked preference migration.

identity.key is an HMAC identification key, not an encryption key.
No filesystem operations occur while importing or computing data_root.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess

try:
    from tools.platforms.paths import private_data_path
except ModuleNotFoundError:
    from platforms.paths import private_data_path


def _native_security():
    # Help/import on other platforms must not load a Windows ctypes backend.
    try:
        from tools import windows_security
    except ModuleNotFoundError:
        import windows_security
    return windows_security


def secure_directory(path):
    return _native_security().secure_directory(path)


def verify_acl(path):
    return _native_security().verify_acl(path)


def data_root(project_root=None, local_app_data=None, *, system=None, home=None, xdg_data_home=None):
    root = project_root if project_root is not None else os.path.join(os.path.dirname(__file__), os.pardir)
    if local_app_data is not None and system is None:
        if not local_app_data:
            raise ValueError("private_data_location")
        # The explicit legacy override remains identical on the host OS.
        identity = os.path.abspath(root).replace("\\", "/").lower()
        digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
        return Path(os.path.abspath(local_app_data)) / "WebKakao" / digest
    return Path(private_data_path(root, local_app_data, system=system, home=home, xdg_data_home=xdg_data_home))


def is_junction(path):
    """Python 3.11-compatible junction check without following the target."""
    try:
        info = Path(path).lstat()
    except FileNotFoundError:
        return False
    tag = getattr(info, "st_reparse_tag", None)
    if tag is None:
        # POSIX stat results have no reparse tag; the Windows constant is absent
        # there as well. Symlinks and POSIX permissions are checked separately.
        return False
    return tag == stat.IO_REPARSE_TAG_MOUNT_POINT


def ensure_private_directory(path):
    target = Path(path).absolute()
    if os.name != "nt":
        return _ensure_posix_directory(target)
    for parent in [target, *target.parents]:
        if parent.is_symlink() or is_junction(parent) or parent.exists() and not parent.is_dir():
            raise ValueError("private_data_path")
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    secure_directory(target)
    return target


def _posix_directory_info(info, uid, *, private=False):
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, uid):
        raise ValueError("private_data_path")
    mode = stat.S_IMODE(info.st_mode)
    if private:
        if info.st_uid != uid or mode != 0o700:
            raise ValueError("private_data_acl")
    elif mode & 0o022 and not (info.st_uid == 0 and mode & stat.S_ISVTX):
        raise ValueError("private_data_ancestor")


def _same_entry(before, after, *, file=False):
    return all(getattr(before, key) == getattr(after, key)
               for key in ("st_dev", "st_ino", "st_uid", "st_mode") + (("st_nlink",) if file else ()))


def _posix_ancestors(path, *, private=False):
    uid = os.getuid()
    snapshots = []
    for item in reversed([path, *path.parents]):
        info = item.lstat()
        _posix_directory_info(info, uid, private=private and item == path)
        snapshots.append((item, info))
    return snapshots


def _posix_unchanged(snapshots):
    for path, before in snapshots:
        if not _same_entry(before, path.lstat()):
            raise ValueError("private_data_changed")


def _ensure_posix_directory(target):
    """Create only missing components; never chmod an existing foreign path."""
    uid = os.getuid()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root = Path(target.anchor)
    fd = os.open(root, flags)
    try:
        _posix_directory_info(os.fstat(fd), uid)
        current = root
        for component in target.parts[1:]:
            current /= component
            try:
                info = os.stat(component, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                try:
                    os.mkdir(component, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass  # A competing creator must satisfy the same checks.
                info = os.stat(component, dir_fd=fd, follow_symlinks=False)
            _posix_directory_info(info, uid, private=current == target)
            child = os.open(component, flags, dir_fd=fd)
            if not _same_entry(info, os.fstat(child)):
                os.close(child)
                raise ValueError("private_data_changed")
            os.close(fd)
            fd = child
        snapshots = _posix_ancestors(target, private=True)
        if not _same_entry(snapshots[-1][1], os.fstat(fd)):
            raise ValueError("private_data_changed")
        _posix_unchanged(snapshots)
    finally:
        os.close(fd)
    return target


def _verify_posix_file(path, info, max_bytes):
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
        raise ValueError("private_file_acl")
    snapshots = _posix_ancestors(path.absolute().parent, private=True)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        if not _same_entry(info, opened, file=True) or opened.st_size != info.st_size or opened.st_size > max_bytes:
            raise ValueError("private_file_changed")
        _posix_unchanged(snapshots)
        after = path.lstat()
        if not _same_entry(info, after, file=True) or any(getattr(info, key) != getattr(after, key)
                                            for key in ("st_size", "st_mtime_ns", "st_ctime_ns")):
            raise ValueError("private_file_changed")
    finally:
        os.close(fd)
    return True


def verify_private_file(path, *, max_bytes=1024 * 1024):
    """Reject symlinks, oversized files and preexisting broad explicit ACLs."""
    path = Path(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        if os.name != "nt":
            # A missing leaf must not bypass validation of its storage folder.
            _posix_ancestors(path.absolute().parent, private=True)
        return False
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_size > max_bytes:
        raise ValueError("private_file_path")
    for parent in path.absolute().parents:
        if parent.is_symlink() or is_junction(parent) or not parent.is_dir():
            raise ValueError("private_file_path")
    if os.name == "nt":
        verify_acl(path)
    else:
        return _verify_posix_file(path, info, max_bytes)
    return True


def _settings(value):
    return isinstance(value, dict) and bool(value) and all(
        isinstance(item, bool) if key in {"persist", "notifications", "readSync"}
        else key == "roomFilter" and isinstance(item, str) and item in {"all", "unread", "pinned"}
        for key, item in value.items())


def _room(value):
    if not isinstance(value, dict) or not value:
        return False
    for key, item in value.items():
        if key == "title":
            valid = item is None or isinstance(item, str) and bool(item.strip()) and len(item.strip()) <= 120 and not re.search(r"[\x00-\x1f\x7f]", item)
        elif key == "pinOrder":
            valid = item is None or type(item) is int and 0 <= item <= 100000
        else:
            valid = key == "muted" and isinstance(item, bool)
        if not valid:
            return False
    return True


def migrate_preferences(source, destination, *, server_active=False):
    """Copy validated key and preferences together; retain originals for user cleanup.

    Caller must positively establish that all installation servers are stopped.
    No source values or paths are included in the result or validation errors.
    """
    source, destination = Path(source).absolute(), Path(destination).absolute()
    if server_active:
        raise ValueError("migration_active_server")
    for candidate in [source, *source.parents, destination, *destination.parents]:
        if candidate.is_symlink() or is_junction(candidate):
            raise ValueError("migration_symlink")
    if not source.is_dir() or destination.exists() or source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("migration_path")
    files = list(source.iterdir())
    if not files or len(files) > 501:
        raise ValueError("migration_scope")
    contents = {}
    for item in files:
        if item.is_symlink() or not item.is_file() or not (item.name == "identity.key" or re.fullmatch(r"[a-f0-9]{64}\.json", item.name)):
            raise ValueError("migration_scope")
        if item.stat().st_size > 1024 * 1024:
            raise ValueError("migration_size")
        contents[item.name] = item.read_bytes()
    if len(contents.get("identity.key", b"")) != 32:
        raise ValueError("migration_key")
    for name, content in contents.items():
        if name == "identity.key":
            continue
        try:
            value = json.loads(content.decode("utf-8"))
            valid = isinstance(value, dict) and type(value.get("version")) is int and value["version"] == 1 and _settings(value.get("settings")) and isinstance(value.get("rooms"), dict) and len(value["rooms"]) <= 500
            valid = valid and all(re.fullmatch(r"[a-f0-9]{64}", key) and _room(room) for key, room in value["rooms"].items())
        except (ValueError, UnicodeError, TypeError):
            valid = False
        if not valid:
            raise ValueError("migration_settings")
    # Reserve the destination atomically so a concurrent invocation cannot
    # overwrite a completed migration. Only validated bytes reach this folder.
    destination.mkdir(parents=True, exist_ok=False, mode=0o700)
    try:
        ensure_private_directory(destination)
        for name, content in contents.items():
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            with os.fdopen(os.open(destination / name, flags, 0o600), "wb") as stream:
                stream.write(content)
            if (destination / name).read_bytes() != content:
                raise RuntimeError("migration_verification")
    except Exception:
        # This directory was exclusively created above and contains our copies.
        shutil.rmtree(destination)
        raise
    return {"status": "copied", "settingsFiles": len(contents) - 1,
            "keyIncluded": True, "sourceRetained": True, "cloudCopiesRemoved": False}
