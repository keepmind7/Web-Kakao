"""Pure OS-specific installation paths; no filesystem or process operations."""
import hashlib
import ntpath
import os
import platform
import posixpath


def system_name(system=None):
    value = platform.system() if system is None else system
    names = {"Windows": "Windows", "win32": "Windows", "Linux": "Linux", "linux": "Linux",
             "Darwin": "Darwin", "darwin": "Darwin"}
    if value not in names:
        raise ValueError("private_data_platform")
    return names[value]


def private_data_path(project_root, local_app_data=None, *, system=None, home=None,
                      xdg_data_home=None, environ=None):
    """Keep Windows IDs unchanged and preserve case on POSIX installations."""
    system = system_name(system)
    env = os.environ if environ is None else environ
    if system == "Windows":
        root = ntpath.abspath(os.fspath(project_root)).replace("\\", "/").lower()
        base = local_app_data if local_app_data is not None else env.get("LOCALAPPDATA")
        if not base:
            raise ValueError("private_data_location")
        base = ntpath.abspath(os.fspath(base))
        path = ntpath
    else:
        root = posixpath.abspath(os.fspath(project_root))
        user_home = home if home is not None else env.get("HOME")
        candidate = xdg_data_home if xdg_data_home is not None else env.get("XDG_DATA_HOME")
        absolute_xdg = bool(candidate and posixpath.isabs(os.fspath(candidate)))
        if (system == "Darwin" or not absolute_xdg) and (not user_home or not posixpath.isabs(os.fspath(user_home))):
            raise ValueError("private_data_location")
        if system == "Darwin":
            base = posixpath.join(os.fspath(user_home), "Library", "Application Support")
        else:
            # XDG specifies that relative values are ignored.
            base = os.fspath(candidate) if absolute_xdg else posixpath.join(os.fspath(user_home), ".local", "share")
        base = posixpath.normpath(base)
        path = posixpath
    install = hashlib.sha256(root.encode("utf-8")).hexdigest()[:16]
    return path.join(base, "WebKakao", install)
