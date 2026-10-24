"""Windows compatibility adapter. Native trust checks remain in windows_security."""
import os
from pathlib import Path
import re
import subprocess


BROAD_PRINCIPALS = ("EVERYONE:", "BUILTIN\\USERS:", "NT AUTHORITY\\AUTHENTICATED USERS:",
                    "CODEXSANDBOXUSERS:", "*S-1-1-0:", "*S-1-5-11:", "*S-1-5-32-545:")


def _security():
    try:
        from tools import windows_security
    except ModuleNotFoundError:
        import windows_security
    return windows_security


def listener_owners(port):
    return _security().listener_owners(port)


def process_image(pid):
    return _security().process_image(pid)


def spawn_options():
    return {"creationflags": subprocess.CREATE_NO_WINDOW}


def open_log(path, verify):
    # Windows inheritance and preflight ACL behavior are deliberately preserved.
    return Path(path).open("ab")


def find_browser(name):
    tails = {"chrome": Path("Google/Chrome/Application/chrome.exe"),
             "edge": Path("Microsoft/Edge/Application/msedge.exe")}
    if name not in tails:
        return None
    for variable in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "LOCALAPPDATA"):
        value = os.environ.get(variable)
        if not value or not Path(value).is_absolute():
            continue
        executable = Path(value) / tails[name]
        try:
            if executable.is_file():
                return executable
        except OSError:
            continue
    return None


def broad_write_warnings(root):
    """Read-only audit. Never repairs the project ACL or blocks an existing start."""
    found = []
    for path in [root, root / "local-only/runtime", root / "local-only/spikes", root / "experiments/local-web"]:
        if not path.exists():
            continue
        try:
            output = subprocess.run(["icacls", str(path)], capture_output=True, timeout=10,
                                    creationflags=subprocess.CREATE_NO_WINDOW).stdout.decode("oem", "replace")
        except (OSError, subprocess.SubprocessError):
            continue
        for line in output.upper().splitlines():
            for principal in BROAD_PRINCIPALS:
                index = line.find(principal)
                groups = re.findall(r"\(([^)]*)\)", line[index + len(principal):]) if index >= 0 else []
                if groups and "DENY" not in groups and {"F", "M", "W", "WD", "AD"} & {right for group in groups for right in group.split(",")}:
                    found.append(path)
                    break
            if found and found[-1] == path:
                break
    return found
