"""Prepare trusted, isolated SBF crates without resolving the native workspace.

The native workspace stays on Rust 1.76 for OpenBook's account layout. These
separately locked crates compile unchanged program source with the SBF compiler.
"""
import shutil
import sys
from pathlib import Path


PROGRAMS = ('autobahn-executor', 'mock_swap')


def isolated_manifest(text):
    # Deliberately fail when the trusted manifest changes beyond this recipe.
    marker = 'solana-program = "1.17"'
    if text.count(marker) != 1 or '[workspace]' in text or '[profile.' in text:
        raise ValueError('SBF isolation recipe must be updated for this manifest')
    text = text.split('[dev-dependencies]', 1)[0].rstrip()
    text = text.replace(marker, 'solana-program = "=1.17.34"')
    return text + '\n\n[workspace]\n\n[profile.release]\noverflow-checks = true\n'


def prepare(policy, output):
    output.mkdir(parents=True, exist_ok=False)
    for name in PROGRAMS:
        source = policy / 'programs' / name
        destination = output / name
        shutil.copytree(source / 'src', destination / 'src')
        (destination / 'Cargo.toml').write_text(isolated_manifest((source / 'Cargo.toml').read_text()))
        shutil.copyfile(policy / 'ci/sbf-locks' / f'{name}.lock', destination / 'Cargo.lock')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise ValueError('trusted policy and new output directories required')
    prepare(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
