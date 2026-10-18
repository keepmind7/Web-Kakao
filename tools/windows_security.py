"""Windows security/process checks through Win32 APIs, without shell processes.

No IO on import. Security descriptors are read on every check; ACL results are
never cached. See GetNamedSecurityInfoW/SetNamedSecurityInfoW, GetAce,
GetExtendedTcpTable and QueryFullProcessImageNameW on learn.microsoft.com.
"""
import argparse
import ctypes as C
from ctypes import wintypes as W
from functools import lru_cache
import json
import os
from pathlib import Path
import socket
import stat
import sys


@lru_cache(maxsize=1)
def _api():
    if os.name != 'nt':
        raise OSError('windows_required')
    adv = C.WinDLL('advapi32', use_last_error=True)
    kernel = C.WinDLL('kernel32', use_last_error=True)
    ip = C.WinDLL('iphlpapi', use_last_error=True)
    pointer = C.c_void_p
    signatures = [
        (adv, 'OpenProcessToken', [W.HANDLE, W.DWORD, C.POINTER(W.HANDLE)], W.BOOL),
        (adv, 'GetTokenInformation', [W.HANDLE, C.c_int, pointer, W.DWORD, C.POINTER(W.DWORD)], W.BOOL),
        (adv, 'ConvertSidToStringSidW', [pointer, C.POINTER(W.LPWSTR)], W.BOOL),
        (adv, 'GetNamedSecurityInfoW', [W.LPCWSTR, C.c_int, W.DWORD, C.POINTER(pointer), pointer, C.POINTER(pointer), pointer, C.POINTER(pointer)], W.DWORD),
        (adv, 'GetSecurityDescriptorControl', [pointer, C.POINTER(W.WORD), C.POINTER(W.DWORD)], W.BOOL),
        (adv, 'GetAce', [pointer, W.DWORD, C.POINTER(pointer)], W.BOOL),
        (adv, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', [W.LPCWSTR, W.DWORD, C.POINTER(pointer), pointer], W.BOOL),
        (adv, 'GetSecurityDescriptorOwner', [pointer, C.POINTER(pointer), C.POINTER(W.BOOL)], W.BOOL),
        (adv, 'GetSecurityDescriptorDacl', [pointer, C.POINTER(W.BOOL), C.POINTER(pointer), C.POINTER(W.BOOL)], W.BOOL),
        (adv, 'SetNamedSecurityInfoW', [W.LPWSTR, C.c_int, W.DWORD, pointer, pointer, pointer, pointer], W.DWORD),
        (kernel, 'GetCurrentProcess', [], W.HANDLE),
        (kernel, 'CloseHandle', [W.HANDLE], W.BOOL),
        (kernel, 'LocalFree', [pointer], pointer),
        (kernel, 'OpenProcess', [W.DWORD, W.BOOL, W.DWORD], W.HANDLE),
        (kernel, 'QueryFullProcessImageNameW', [W.HANDLE, W.DWORD, W.LPWSTR, C.POINTER(W.DWORD)], W.BOOL),
        (ip, 'GetExtendedTcpTable', [pointer, C.POINTER(W.DWORD), W.BOOL, W.ULONG, C.c_int, W.ULONG], W.DWORD),
    ]
    for dll, name, args, result in signatures:
        function = getattr(dll, name)
        function.argtypes, function.restype = args, result
    return adv, kernel, ip


def _ok(value):
    if not value:
        raise C.WinError(C.get_last_error())


def _sid(value):
    if not value:
        raise ValueError('private_file_owner')
    adv, kernel, _ = _api()
    output = W.LPWSTR()
    _ok(adv.ConvertSidToStringSidW(value, C.byref(output)))
    try:
        return output.value
    finally:
        kernel.LocalFree(output)


def current_sid():
    adv, kernel, _ = _api()
    handle = W.HANDLE()
    _ok(adv.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, C.byref(handle)))
    try:
        size = W.DWORD()
        adv.GetTokenInformation(handle, 1, None, 0, C.byref(size))
        if not 0 < size.value < 65536:
            raise ValueError('token_size')
        data = C.create_string_buffer(size.value)
        _ok(adv.GetTokenInformation(handle, 1, data, size, C.byref(size)))
        return _sid(C.cast(data, C.POINTER(C.c_void_p))[0])
    finally:
        kernel.CloseHandle(handle)


class _Acl(C.Structure):
    _fields_ = [('revision', W.BYTE), ('reserved', W.BYTE), ('size', W.WORD), ('count', W.WORD), ('reserved2', W.WORD)]


def _path(path, *, directory=False):
    target = Path(path).absolute()
    for item in [target, *target.parents]:
        try:
            info = item.lstat()
        except FileNotFoundError:
            if directory:
                continue
            raise
        if info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT or item != target and not stat.S_ISDIR(info.st_mode):
            raise ValueError('private_data_path')
    return target


def verify_acl(path, *, directory=False):
    adv, kernel, _ = _api()
    sid = current_sid()
    owner, acl, descriptor = C.c_void_p(), C.c_void_p(), C.c_void_p()
    result = adv.GetNamedSecurityInfoW(str(path), 1, 0x5, C.byref(owner), None, C.byref(acl), None, C.byref(descriptor))
    if result:
        raise C.WinError(result)
    try:
        if _sid(owner) != sid:
            raise ValueError('private_file_owner')
        if not acl:
            raise ValueError('private_file_acl')
        header = C.cast(acl, C.POINTER(_Acl)).contents
        if not header.count or header.size < 8:
            raise ValueError('private_file_acl')
        allowed = {sid, 'S-1-5-18', 'S-1-5-32-544'}
        identities = []
        for index in range(header.count):
            ace = C.c_void_p()
            _ok(adv.GetAce(acl, index, C.byref(ace)))
            kind, flags, size = C.c_ubyte.from_address(ace.value).value, C.c_ubyte.from_address(ace.value + 1).value, C.c_ushort.from_address(ace.value + 2).value
            if kind != 0 or size < 12 or not acl.value + 8 <= ace.value <= acl.value + header.size - size:
                raise ValueError('private_file_acl')
            identity = _sid(ace.value + 8)
            if identity not in allowed:
                raise ValueError('private_file_acl')
            identities.append(identity)
            if directory and (flags != 3 or C.c_uint32.from_address(ace.value + 4).value != 0x1f01ff):
                raise ValueError('private_acl')
        if directory:
            control, revision = W.WORD(), W.DWORD()
            _ok(adv.GetSecurityDescriptorControl(descriptor, C.byref(control), C.byref(revision)))
            if not control.value & 0x1000 or len(identities) != 3 or set(identities) != allowed:
                raise ValueError('private_acl')
    finally:
        kernel.LocalFree(descriptor)
    return True


def secure_directory(path):
    target = _path(path, directory=True)
    target.mkdir(parents=True, exist_ok=True)
    _path(target)
    if not target.is_dir():
        raise ValueError('private_data_path')
    adv, kernel, _ = _api()
    sid = current_sid()
    descriptor, owner, acl = C.c_void_p(), C.c_void_p(), C.c_void_p()
    default, present = W.BOOL(), W.BOOL()
    sddl = f'O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
    _ok(adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, C.byref(descriptor), None))
    try:
        _ok(adv.GetSecurityDescriptorOwner(descriptor, C.byref(owner), C.byref(default)))
        _ok(adv.GetSecurityDescriptorDacl(descriptor, C.byref(present), C.byref(acl), C.byref(default)))
        result = adv.SetNamedSecurityInfoW(str(target), 1, 0x80000005, owner, None, acl, None)
        if result:
            raise C.WinError(result)
    finally:
        kernel.LocalFree(descriptor)
    verify_acl(target, directory=True)
    return target


def verify_file(path, *, max_bytes=1024 * 1024):
    try:
        target = _path(path)
    except FileNotFoundError:
        return False
    info = target.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
        raise ValueError('private_file_path')
    return verify_acl(target)


def listener_owners(port):
    _, _, ip = _api()
    owners = set()
    for family, stride, port_offset, pid_offset in [(socket.AF_INET, 24, 8, 20), (socket.AF_INET6, 56, 20, 52)]:
        for attempt in range(3):
            size = W.DWORD()
            result = ip.GetExtendedTcpTable(None, C.byref(size), False, family, 3, 0)
            if result not in (0, 122) or not 4 <= size.value <= 16 * 1024 * 1024:
                raise OSError('listener_table_unavailable')
            data = C.create_string_buffer(size.value)
            result = ip.GetExtendedTcpTable(data, C.byref(size), False, family, 3, 0)
            if result == 122:
                continue
            if result:
                raise C.WinError(result)
            count = C.c_uint32.from_buffer(data).value
            if 4 + count * stride > len(data):
                raise ValueError('listener_table_size')
            for index in range(count):
                offset = 4 + index * stride
                local_port = C.c_uint32.from_buffer(data, offset + port_offset).value
                if socket.ntohs(local_port & 0xffff) == port:
                    owners.add(C.c_uint32.from_buffer(data, offset + pid_offset).value)
            break
        else:
            raise OSError('listener_table_unstable')
    return owners


def process_image(pid):
    _, kernel, _ = _api()
    handle = kernel.OpenProcess(0x1000, False, pid)
    _ok(handle)
    try:
        size = W.DWORD(32768)
        buffer = C.create_unicode_buffer(size.value)
        _ok(kernel.QueryFullProcessImageNameW(handle, 0, buffer, C.byref(size)))
        return buffer.value
    finally:
        kernel.CloseHandle(handle)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['directory', 'file'])
    parser.add_argument('path')
    parser.add_argument('--max-bytes', type=int, default=1024 * 1024)
    args = parser.parse_args(argv)
    if os.name != 'nt' or sys.version_info < (3, 11) or args.max_bytes < 0:
        parser.exit(2, 'Windows와 Python 3.11 이상이 필요합니다.\n')
    try:
        value = bool(secure_directory(args.path)) if args.action == 'directory' else verify_file(args.path, max_bytes=args.max_bytes)
    except (OSError, ValueError):
        parser.exit(2, '개인 저장소 권한을 확인할 수 없습니다.\n')
    print(json.dumps(value))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
