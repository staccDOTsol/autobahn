import importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('generate',Path(__file__).with_name('generate.py'))
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
class RegistryTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  (self.root/'adapters').mkdir();(self.root/'lib/dex-test/src').mkdir(parents=True)
  (self.root/'lib/dex-test/Cargo.toml').write_text('[package]\nname="dex-test"')
  self.data={'id':'test','crate':'dex-test','type':'TestDex','operations':['swap','add-liquidity'],'requiresConfiguration':False,'provenance':{'source':'test','revision':'1','license':'MIT'}}
 def tearDown(self): self.tmp.cleanup()
 def save(self): (self.root/'adapters/test.json').write_text(json.dumps(self.data))
 def test_compiled_registration(self):
  self.save();g.generate(self.root);g.generate(self.root,True)
  self.assertIn('dex_test::TestDex::initialize',(self.root/'lib/adapter-registry/src/lib.rs').read_text())
 def test_no_injection_in_type(self):
  self.data['type']='TestDex; panic!()';self.save()
  with self.assertRaises(ValueError):g.generate(self.root)
 def test_wrong_path(self):
  self.data['crate']='../../evil';self.save()
  with self.assertRaises(ValueError):g.generate(self.root)
 def test_missing_provenance(self):
  self.data['provenance']={};self.save()
  with self.assertRaises(ValueError):g.generate(self.root)
 def test_drift_rejected(self):
  self.save();g.generate(self.root);(self.root/'lib/adapter-registry/src/lib.rs').write_text('wrong')
  with self.assertRaises(ValueError):g.generate(self.root,True)
 def test_config_required_is_explicit(self):
  self.data['requiresConfiguration']=True;self.save();g.generate(self.root)
  self.assertIn('configured.contains_key("test")',(self.root/'lib/adapter-registry/src/lib.rs').read_text())
if __name__=='__main__':unittest.main()
