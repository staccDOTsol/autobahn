#!/usr/bin/env python3
import os
from policy import github, read_pr, Rejected
from admission_queue import dispatch_current
repo=os.environ['GITHUB_REPOSITORY'];number=os.environ['PR_NUMBER'];sha=os.environ['CANDIDATE_SHA'];base=os.environ['BASE_SHA']
pr,ids=read_pr(repo,number)
if pr['head']['sha']!=sha or pr['base']['sha']!=base:
 dispatch_current(repo,number)
 raise SystemExit('PR or base moved; automatically queued fresh tests')
# Only this trusted post-CI job can publish the admission status. No candidate checkout.
github(f'repos/{repo}/statuses/{sha}','POST',{'state':'success','context':'Adapter admission','description':'Scope, build, conformance and independent replay passed','target_url':os.environ['RUN_URL']})
result=github(f'repos/{repo}/pulls/{number}/merge','PUT',{'sha':sha,'merge_method':'squash','commit_title':f'Admit adapters: {", ".join(ids)} (#{number})'})
if not result.get('merged'): raise Rejected(result.get('message','merge refused'))
# GITHUB_TOKEN pushes do not start push workflows. Dispatch deployment explicitly.
github(f'repos/{repo}/actions/workflows/deploy-router.yml/dispatches','POST',{'ref':pr['base']['ref'],'inputs':{'sha':result['sha']}})
print('Merged and dispatched deployment:',result['sha'])
