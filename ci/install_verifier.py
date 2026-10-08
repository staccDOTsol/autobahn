"""Select the exact trusted Cargo artifact; never glob stale executables."""
import json
import shutil
import sys
import subprocess
from pathlib import Path

executables = []
for line in Path(sys.argv[1]).read_text().splitlines():
    item = json.loads(line)
    if item.get('reason') == 'compiler-artifact' and item.get('executable') and item.get('target', {}).get('name') == 'test_all':
        executables.append(item['executable'])
if len(executables) != 1:
    raise ValueError('expected exactly one independently compiled verifier')
destination = Path(sys.argv[2])
destination.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(executables[0], destination)
destination.chmod(0o555)

kind = sys.argv[3] if len(sys.argv) == 4 else 'replay'
required = {
    'replay': {'cases::test_swap_from_dump::test_admission_replay'},
    'executor': {
        'test_cases::test_exec::should_do_a_one_hop_execution',
        'test_cases::test_exec::should_do_a_two_hops_execution',
        'test_cases::test_exec::should_do_a_three_hops_swap',
        'test_cases::test_exec::should_fail_when_max_slippage_is_reached',
        'test_cases::test_fees::should_charge_platform_fee',
        'test_cases::test_fees::should_split_fee_between_platform_and_referrer',
        'test_cases::test_fees::should_work_with_referrer_derived_address',
    },
}[kind]
listing = subprocess.check_output([str(destination), '--list'], text=True)
tests = {line.removesuffix(': test') for line in listing.splitlines() if line.endswith(': test')}
if not required <= tests:
    raise ValueError('trusted executable does not contain every required ' + kind + ' test')
