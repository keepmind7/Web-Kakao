"""공식 Node 24 Windows ZIP을 작업 폴더에만 보관하는 조사용 준비 도구."""
import argparse
import json
import zipfile
from pathlib import Path
from urllib.request import urlopen
try:
    from tools.cli_support import parse_arguments, run_preparation
    from tools.prepare_rea_windows import install_archive
    from tools.safe_download import checked_path, ensure_download
except ModuleNotFoundError:
    from cli_support import parse_arguments, run_preparation
    from prepare_rea_windows import install_archive
    from safe_download import checked_path, ensure_download

ROOT = Path(__file__).absolute().parent.parent
BASE = "https://nodejs.org/dist/v24.21.0/"
FILENAME = "node-v24.21.0-win-x64.zip"
# Pinned from the official SHASUMS256.txt-verified download recorded in evidence/alternatives/node-runtime.json.
EXPECTED = "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541"


def main(target_root=ROOT / "local-only/runtime"):
    try:
        target_root = checked_path(target_root)
        folder = checked_path(target_root / FILENAME.removesuffix(".zip"))
        archive = ensure_download(target_root / FILENAME, BASE + FILENAME, EXPECTED, opener=urlopen)
        with zipfile.ZipFile(archive) as source:
            if any(member.filename.split('/')[0] != folder.name for member in source.infolist()):
                raise ValueError('unexpected_node_install_directory')
        # Existing and newly staged runtimes must match every trusted ZIP entry.
        install_archive(archive, target_root, ['node.exe', 'node_modules/npm/bin/npm-cli.js'])
    except ValueError:
        raise SystemExit("고정 ZIP 또는 런타임 파일 검증에 실패하여 실행 준비를 중단합니다.") from None
    return {"source": BASE + FILENAME, "sha256": EXPECTED,
            "directory": folder.relative_to(ROOT).as_posix() if folder.is_relative_to(ROOT) else str(folder),
            "global_install": False, "account_used": False}


def cli(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parse_arguments(parser, argv)
    return run_preparation(parser, prepare_cli)


def prepare_cli():
    record = main()
    evidence = ROOT / "evidence/alternatives"
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "node-runtime.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(record, indent=2))
    return 0


if __name__ == "__main__":
    cli()
