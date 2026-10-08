"""Unprivileged candidate worker. Its entire output is untrusted."""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path('/work/router')

def run(args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env={**os.environ, **(env or {})}, check=True, timeout=3000)

if sys.argv[1] == 'build':
    shutil.copytree('/candidate', ROOT, ignore=shutil.ignore_patterns('.git', 'target', '.env*', 'node_modules'))
    run(['npm', 'ci', '--ignore-scripts', '--omit=dev', '--prefix', 'lib/dex-meteora-dbc/worker'])
    run(['npm', 'test', '--prefix', 'lib/dex-meteora-dbc/worker'])
    run(['cargo', 'build', '--locked', '--workspace', '--all-targets'])
    run(['cargo', 'test', '--locked', '-p', 'autobahn-router', '--bin', 'autobahn-router'])
    run(['cargo', 'test', '--locked', '-p', 'autobahn-executor'])
    for path in sorted((ROOT / 'adapters').glob('*.json')):
        manifest = json.loads(path.read_text())
        run(['cargo', 'test', '--locked', '-p', manifest['crate'], '--lib'])
elif sys.argv[1] == 'capture':
    name, amount = sys.argv[2:4]
    crate = ROOT / 'lib' / ('dex-' + name)
    descriptor = json.loads((crate / 'fixtures/admission.json').read_text())
    options = Path('/tmp/options.json')
    options.write_text(json.dumps(descriptor['options']))
    args = [str(ROOT / 'target/debug/adapter-admission'), name, '/tmp/snapshot.lz4', str(options)]
    env = {'ADMISSION_STRICT': '1', 'ADMISSION_AMOUNT': amount, 'ADMISSION_RPC_URL': 'http://recorder:8080'}
    run(args, cwd=crate, env={**env, 'ADMISSION_CAPTURE': '1'})
    run(args, cwd=crate, env=env)
    shutil.copyfile(ROOT / 'programs/simulator/tests/fixtures/admission_swap.lz4', '/output/replay.lz4')
else:
    raise ValueError('unknown candidate phase')
