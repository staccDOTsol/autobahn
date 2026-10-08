import os
from admission_queue import dispatch_current
from policy import github

repo, number = os.environ['GITHUB_REPOSITORY'], os.environ['PR_NUMBER']
pr = github(f'repos/{repo}/pulls/{number}')
if pr['state'] == 'open' and not pr['draft'] and (pr['head']['sha'] != os.environ['CANDIDATE_SHA'] or pr['base']['sha'] != os.environ['BASE_SHA']):
    dispatch_current(repo, number)
