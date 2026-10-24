"""Shared launcher policy, with OS effects delegated to explicit adapters."""
import platform


SERVER_ENV = frozenset({
    "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP",
    "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE", "LANG", "LC_ALL", "LC_CTYPE", "HOME", "XDG_DATA_HOME",
    "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR",
})


def backend(system=None):
    """Do not guess a backend for unsupported platforms such as macOS."""
    system = platform.system() if system is None else system
    if system == "Windows":
        from . import windows
        return windows
    if system == "Linux":
        from . import linux
        return linux
    raise ValueError("unsupported_launcher_platform")


def server_environment(environ, python_executable, *, system=None):
    system = platform.system() if system is None else system
    backend(system)  # Reject before returning a partial environment.
    environment = {key: value for key, value in environ.items()
                   if (key.upper() if system == "Windows" else key) in SERVER_ENV}
    # Caller-controlled Node/TLS/proxy/loader hints never reach a child.
    environment["WEB_KAKAO_PYTHON"] = python_executable
    return environment
