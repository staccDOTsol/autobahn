import importlib.util, sys, os, json
from pathlib import Path
from policy import check_tree
root=Path(sys.argv[1]).resolve()
ids=check_tree(root,sys.argv[2],sys.argv[3])
spec=importlib.util.spec_from_file_location('registry',Path(__file__).resolve().parents[1]/'tools/registry/generate.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
entries=m.generate(root,check=True)
if not set(ids)<={e['id'] for e in entries}: raise ValueError('each changed adapter must have a compiled manifest')
print('Scope and registry verified:',','.join(ids))

if os.environ.get('GITHUB_OUTPUT'):
 with open(os.environ['GITHUB_OUTPUT'],'a') as output: output.write('adapters='+json.dumps(ids)+'\n')
