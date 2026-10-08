#!/usr/bin/env python3
"""Trusted host orchestration. Candidate code never shares a verifier tree/process.

Run from the default-branch policy checkout on a disposable CI runner.
Only the recorder knows the upstream URL; only it writes canonical records.
"""
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

POLICY = Path(__file__).resolve().parents[1]
LIMITS = ['--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=1024', '--memory=10g', '--cpus=4']

def run(args, timeout=3600):
    return subprocess.run(args, check=True, timeout=timeout)

def descriptor(root, name):
    if not re.fullmatch(r'[a-z][a-z0-9]*(?:-[a-z0-9]+)*', name):
        raise ValueError('invalid adapter ID')
    path = root / 'lib' / ('dex-' + name) / 'fixtures/admission.json'
    if path.is_symlink() or path.stat().st_size > 64 * 1024:
        raise ValueError('invalid admission descriptor')
    evidence = json.loads(path.read_text())
    if set(evidence) != {'options', 'amounts'}:
        raise ValueError('invalid descriptor fields')
    amounts = evidence['amounts']
    if not isinstance(amounts, list) or not 2 <= len(amounts) <= 8 or any(type(n) != int or not 0 < n <= (2**64 - 1)//2 for n in amounts) or len(set(amounts)) != len(amounts):
        raise ValueError('two to eight distinct positive bounded u64 amounts required')
    if not isinstance(evidence['options'], dict) or any(type(k) != str or type(v) != str for k, v in evidence['options'].items()):
        raise ValueError('invalid adapter options')
    return amounts

def copy_evidence(source, destination):
    # Do not follow paths/symlinks emitted by candidate code on the host.
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as reader:
        info = os.fstat(reader.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 256 * 1024 * 1024:
            raise ValueError('invalid execution artifact')
        with open(destination, 'xb') as writer:
            remaining = info.st_size
            while remaining:
                data = reader.read(min(1024 * 1024, remaining))
                if not data: raise ValueError('truncated execution artifact')
                writer.write(data)
                remaining -= len(data)

def validate(source):
    ids = json.loads(os.environ['ADMISSION_ADAPTER_IDS'])
    if not isinstance(ids, list) or not ids or len(ids) > 16: raise ValueError('invalid adapter set')
    cases = [(name, amount) for name in ids for amount in descriptor(source, name)]
    prefix = 'admission-' + uuid.uuid4().hex[:12]
    volume, network = prefix + '-work', prefix + '-rpc'
    run(['docker', 'volume', 'create', volume])
    run(['docker', 'network', 'create', '--internal', network])
    try:
        run(['docker', 'run', '--rm', *LIMITS, '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=1g',
             '-e', 'CI=true', '-e', 'CARGO_HOME=/work/cargo', '-e', 'npm_config_cache=/work/npm', '-v', f'{source}:/candidate:ro', '-v', f'{POLICY}:/policy:ro', '-v', f'{volume}:/work',
             'adapter-validation', 'python3', '/policy/ci/candidate.py', 'build'])
        for name, amount in cases:
            recorder = prefix + '-recorder'
            with tempfile.TemporaryDirectory(prefix=prefix) as directory:
                root = Path(directory)
                output = root / 'candidate'; output.mkdir()
                canonical = root / 'canonical'; canonical.mkdir()
                verified = root / 'verified'; verified.mkdir()
                env = {**os.environ, 'RPC_UPSTREAM': (os.environ.get('RPC_UPSTREAM') or 'https://api.mainnet-beta.solana.com')}
                # This trusted recorder alone can reach the upstream during capture.
                subprocess.run(['docker', 'run', '-d', '--name', recorder, *LIMITS, '--read-only',
                    '--tmpfs', '/tmp:rw,nosuid,size=256m', '-e', 'RPC_UPSTREAM',
                    '-v', f'{POLICY}/ci:/policy:ro', '-v', f'{canonical}:/canonical',
                    'adapter-validation', 'python3', '/policy/rpc_recorder.py', '--host', '0.0.0.0', '--port', '8080', '--snapshot', '/canonical/accounts.json'],
                    env=env, check=True, timeout=60)
                try:
                    run(['docker', 'network', 'connect', '--alias', 'recorder', network, recorder], timeout=60)
                    run(['docker', 'exec', recorder, 'python3', '/policy/wait_tcp.py'], timeout=35)
                    run(['docker', 'run', '--rm', *LIMITS, '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=1g',
                         '--network', network, '-v', f'{POLICY}:/policy:ro', '-v', f'{volume}:/work', '-v', f'{output}:/output',
                         'adapter-validation', 'python3', '/policy/ci/candidate.py', 'capture', name, str(amount)], timeout=600)
                finally:
                    run(['docker', 'stop', '-t', '10', recorder], timeout=30)
                    run(['docker', 'rm', recorder], timeout=30)
                copy_evidence(output / 'replay.lz4', verified / 'replay.lz4')
                # Precompiled verifier, no candidate code/compiler/network/write access.
                run(['docker', 'run', '--rm', *LIMITS, '--read-only', '--network', 'none',
                     '--tmpfs', '/tmp:rw,nosuid,size=256m', '-v', f'{verified}:/evidence:ro', '-v', f'{canonical}:/canonical:ro',
                     '-e', 'ADMISSION_STRICT=1', '-e', f'ADMISSION_AMOUNT={amount}', '-e', 'ADMISSION_REPLAY_PATH=/evidence/replay.lz4',
                     '-e', 'ADMISSION_CANONICAL_PATH=/canonical/accounts.json', 'adapter-verifier'], timeout=600)
                print(f'Independent mainnet replay passed: {name}, input {amount}', flush=True)
    finally:
        subprocess.run(['docker', 'rm', '-f', prefix + '-recorder'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'network', 'rm', network], check=True)
        subprocess.run(['docker', 'volume', 'rm', volume], check=True)

if __name__ == '__main__':
    if len(sys.argv) != 2: raise ValueError('candidate checkout required')
    validate(Path(sys.argv[1]).resolve())
