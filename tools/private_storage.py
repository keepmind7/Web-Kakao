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


def data_root(project_root=None, local_app_data=None):
    root = os.path.abspath(project_root if project_root is not None else os.path.join(os.path.dirname(__file__), os.pardir))
    base = local_app_data if local_app_data is not None else os.environ.get("LOCALAPPDATA")
    if not base:
        raise ValueError("private_data_location")
    digest = hashlib.sha256(root.replace("\\", "/").lower().encode("utf-8")).hexdigest()[:16]
    return Path(os.path.abspath(base)) / "WebKakao" / digest


def is_junction(path):
    """Python 3.11-compatible junction check without following the target."""
    try:
        info = Path(path).lstat()
    except FileNotFoundError:
        return False
    return getattr(info, "st_reparse_tag", 0) == stat.IO_REPARSE_TAG_MOUNT_POINT


def ensure_private_directory(path):
    target = Path(path).absolute()
    for parent in [target, *target.parents]:
        if parent.is_symlink() or is_junction(parent) or parent.exists() and not parent.is_dir():
            raise ValueError("private_data_path")
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name == "nt":
        script = r"""$ErrorActionPreference='Stop';$p=$env:WEBKAKAO_PRIVATE_DIRECTORY;
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$acl=New-Object System.Security.AccessControl.DirectorySecurity;$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);
$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544');foreach($s in $allowed){$id=New-Object System.Security.Principal.SecurityIdentifier($s);$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($id,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)};
Set-Acl -LiteralPath $p -AclObject $acl;$check=Get-Acl -LiteralPath $p;if(!$check.AreAccessRulesProtected){throw 'private_acl'};
$rules=@($check.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]));if($rules.Count -ne 3){throw 'private_acl'};foreach($r in $rules){if($r.IdentityReference.Value -notin $allowed -or $r.AccessControlType -ne 'Allow' -or $r.IsInherited -or $r.FileSystemRights -ne 'FullControl'){throw 'private_acl'}}"""
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                       env={**os.environ, "WEBKAKAO_PRIVATE_DIRECTORY": str(target)},
                       check=True, capture_output=True, timeout=10,
                       creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        target.chmod(0o700)
    return target


def verify_private_file(path, *, max_bytes=1024 * 1024):
    """Reject symlinks, oversized files and preexisting broad explicit ACLs."""
    path = Path(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_size > max_bytes:
        raise ValueError("private_file_path")
    for parent in path.absolute().parents:
        if parent.is_symlink() or is_junction(parent) or not parent.is_dir():
            raise ValueError("private_file_path")
    if os.name == "nt":
        script = r"""$ErrorActionPreference='Stop';$p=$env:WEBKAKAO_PRIVATE_FILE;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
$allowed=@($sid,'S-1-5-18','S-1-5-32-544');$acl=Get-Acl -LiteralPath $p;if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'private_file_owner'};
$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]));if(!$rules.Count){throw 'private_file_acl'};foreach($r in $rules){if($r.IdentityReference.Value -notin $allowed -or $r.AccessControlType -ne 'Allow'){throw 'private_file_acl'}}"""
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                       env={**os.environ, "WEBKAKAO_PRIVATE_FILE": str(path.absolute())}, check=True,
                       capture_output=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
    elif info.st_mode & 0o077:
        raise ValueError("private_file_acl")
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
            with (destination / name).open("xb") as stream:
                stream.write(content)
            if (destination / name).read_bytes() != content:
                raise RuntimeError("migration_verification")
    except Exception:
        # This directory was exclusively created above and contains our copies.
        shutil.rmtree(destination)
        raise
    return {"status": "copied", "settingsFiles": len(contents) - 1,
            "keyIncluded": True, "sourceRetained": True, "cloudCopiesRemoved": False}
