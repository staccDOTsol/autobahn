#!/usr/bin/env python3
"""Trusted adapter admission policy. Never import or execute a candidate's scripts."""
import json, os, re, subprocess, urllib.request
from pathlib import PurePosixPath

ID = r'[a-z][a-z0-9]*(?:-[a-z0-9]+)*'
GENERATED = {'Cargo.lock','lib/adapter-registry/Cargo.toml','lib/adapter-registry/src/lib.rs'}

class Rejected(ValueError): pass

def changed_adapters(files):
    ids=set()
    if not files or len(files)>1000: raise Rejected('empty or oversized patch')
    for item in files:
        name=item['filename']
        if item.get('status') not in {'added','modified'}: raise Rejected('adapter admission permits additions and updates only')
        if name in GENERATED: continue
        if '\\' in name or any(p in {'.','..'} for p in PurePosixPath(name).parts): raise Rejected('unsafe path')
        match=re.fullmatch(rf'lib/dex-({ID})/(?:src|tests|fixtures)/.+',name)
        if not match: match=re.fullmatch(rf'lib/dex-({ID})/worker/(?:[a-zA-Z0-9_-]+[.]mjs|package(?:-lock)?[.]json|test/[a-zA-Z0-9_.-]+[.](?:mjs|json))',name)
        if not match: match=re.fullmatch(rf'lib/dex-({ID})/(?:Cargo.toml|README.md|LICENSE(?:.md)?)',name)
        if not match: match=re.fullmatch(rf'adapters/({ID})[.]json',name)
        if not match: raise Rejected(f'outside adapter scope: {name}')
        ids.add(match.group(1))
    if not ids: raise Rejected('no adapter changes')
    return sorted(ids)

def github(path, method='GET', data=None):
    req=urllib.request.Request('https://api.github.com/'+path,method=method,
        data=None if data is None else json.dumps(data).encode(),headers={
        'Authorization':'Bearer '+os.environ['GH_TOKEN'],
        'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
    with urllib.request.urlopen(req,timeout=30) as response:
        raw=response.read();return json.loads(raw) if raw else None

def read_pr(repo,number):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repo) or not str(number).isdigit(): raise Rejected('invalid repository/PR')
    pr=github(f'repos/{repo}/pulls/{number}')
    default=github(f'repos/{repo}')['default_branch']
    if pr['state']!='open' or pr['draft'] or pr['base']['ref']!=default: raise Rejected('PR must be open, ready, and target default branch')
    if pr['base']['repo']['full_name']!=repo: raise Rejected('wrong base repository')
    files=[]
    for page in range(1,12):
        batch=github(f'repos/{repo}/pulls/{number}/files?per_page=100&page={page}')
        files.extend(batch)
        if len(batch)<100: break
    if len(files)!=pr['changed_files']: raise Rejected('incomplete file inventory')
    ids=changed_adapters(files)
    return pr,ids

def check_tree(root,base,head):
    for sha in (base,head):
        if not re.fullmatch(r'[a-f0-9]{40}',sha): raise Rejected('invalid commit')
    raw=subprocess.check_output(['git','-C',str(root),'diff','--name-status','-z',base,head]).decode().split('\0')
    files=[]
    for i in range(0,len(raw)-1,2):
        status,name=raw[i:i+2]
        if status not in {'A','M'}: raise Rejected('renames/deletions are outside automatic admission')
        files.append({'filename':name,'status':'added' if status=='A' else 'modified'})
        mode=subprocess.check_output(['git','-C',str(root),'ls-tree',head,'--',name]).decode().split()[0]
        if mode not in {'100644','100755'}: raise Rejected('symlink/submodule rejected')
    return changed_adapters(files)
