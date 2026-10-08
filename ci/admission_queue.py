"""Refresh outdated branches and dispatch exact-head tests without reviewer gates."""
import time
from policy import github, read_pr, Rejected

def dispatch_current(repo, number):
    pr, ids = read_pr(repo, number)
    sha, base = pr['head']['sha'], pr['base']['sha']
    comparison = github(f'repos/{repo}/compare/{base}...{sha}')
    if comparison.get('behind_by', 0):
        # Preserve contributor changes; GitHub refuses conflicts and stale heads.
        github(f'repos/{repo}/pulls/{number}/update-branch', 'PUT', {'expected_head_sha': sha})
        for _ in range(15):
            time.sleep(2)
            pr, ids = read_pr(repo, number)
            if pr['head']['sha'] != sha:
                return dispatch_current(repo, number)
        raise Rejected('GitHub branch update is still pending; no merge authorized')
    github(f'repos/{repo}/actions/workflows/adapter-ci.yml/dispatches', 'POST', {
        'ref': pr['base']['ref'], 'inputs': {'pr': str(number), 'sha': sha, 'base': base}})
    print('Dispatched current-base CI:', number, sha, ', '.join(ids))
