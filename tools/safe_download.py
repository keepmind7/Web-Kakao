"""Pinned public downloads with ancestor checks and exclusively owned staging."""
from contextlib import contextmanager
import hashlib
from pathlib import Path
import shutil
import stat
import uuid

try:
    from tools.prepare_rea_windows import reserved_windows_component
except ModuleNotFoundError:
    from prepare_rea_windows import reserved_windows_component


def checked_path(path):
    """Inspect lexical ancestors before following links or touching file contents."""
    path = Path(path)
    if '..' in path.parts:
        raise ValueError('path_traversal_not_allowed')
    path = path.absolute()
    if any(reserved_windows_component(part) for part in path.parts[1:]):
        raise ValueError('reserved_windows_path')
    for current in (*reversed(path.parents), path):
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('reparse_or_symlink_not_allowed')
        if current != path and not stat.S_ISDIR(info.st_mode):
            raise ValueError('ancestor_is_not_directory')
    return path


@contextmanager
def download_stage(destination):
    destination = checked_path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for _ in range(10):
        stage = checked_path(destination / ('download-' + uuid.uuid4().hex))
        try:
            # Preserve inherited DACLs for the published, public runtime bytes.
            stage.mkdir(mode=0o777)
        except FileExistsError:
            continue
        break
    else:
        raise FileExistsError('download_stage_collision_limit')
    identity = stage.lstat()
    try:
        yield stage
    finally:
        checked_path(stage)
        current = stage.lstat()
        if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
            raise ValueError('download_stage_replaced')
        # Only this invocation's newly created directory may be removed.
        shutil.rmtree(stage)


def ensure_download(target, request, expected, *, opener, algorithm='sha256',
                    expected_size=None, timeout=60):
    """Reuse only verified bytes; never open a predictable .partial for writing."""
    target = checked_path(target)

    def verify(path):
        checked_path(path)
        if not path.is_file():
            raise ValueError('asset_is_not_file')
        if expected_size is not None and path.stat().st_size != expected_size:
            raise ValueError('asset_size_mismatch')
        with path.open('rb') as stream:
            actual = hashlib.file_digest(stream, algorithm).hexdigest()
        if actual != expected:
            raise ValueError('asset_checksum_mismatch')

    if target.exists():
        verify(target)
        return target
    with download_stage(target.parent) as stage:
        partial = checked_path(stage / 'asset.partial')
        with partial.open('xb') as output, opener(request, timeout=timeout) as response:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if expected_size is not None and total > expected_size:
                    raise ValueError('archive_size_limit')
                output.write(chunk)
        verify(partial)
        checked_path(target)
        if target.exists():
            raise FileExistsError('asset_destination_collision')
        partial.rename(target)
    return target
