import os
from policy import read_pr, Rejected
pr,_=read_pr(os.environ['GITHUB_REPOSITORY'],os.environ['PR_NUMBER'])
if pr['head']['sha']!=os.environ['CANDIDATE_SHA'] or pr['base']['sha']!=os.environ['BASE_SHA']:
 raise Rejected('requested commit is stale or unrelated to this PR')
