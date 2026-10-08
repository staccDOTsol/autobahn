import unittest
from policy import changed_adapters, Rejected

def file(name,status='added'): return {'filename':name,'status':status}
class PolicyTests(unittest.TestCase):
 def test_adapter(self): self.assertEqual(changed_adapters([file('adapters/meteora-dbc.json'),file('lib/dex-meteora-dbc/src/lib.rs'),file('Cargo.lock','modified')]),['meteora-dbc'])
 def test_no_label_or_author_gate(self): self.assertEqual(changed_adapters([file('lib/dex-new-venue/src/lib.rs')]),['new-venue'])
 def test_workflow_rejected(self):
  with self.assertRaises(Rejected): changed_adapters([file('.github/workflows/adapter-ci.yml','modified')])
 def test_core_rejected(self):
  with self.assertRaises(Rejected): changed_adapters([file('programs/autobahn-executor/src/lib.rs','modified')])
 def test_deleted_adapter_rejected(self):
  with self.assertRaises(Rejected): changed_adapters([file('lib/dex-a/src/lib.rs','removed')])
 def test_build_script_rejected(self):
  with self.assertRaises(Rejected): changed_adapters([file('lib/dex-a/build.rs')])
 def test_traversal_rejected(self):
  with self.assertRaises(Rejected): changed_adapters([file('lib/dex-a/src/../../../../ci/merge.py')])
 def test_generated_only_rejected(self):
  with self.assertRaises(Rejected): changed_adapters([file('Cargo.lock','modified')])
 def test_rename_rejected(self):
  with self.assertRaises(Rejected): changed_adapters([file('lib/dex-a/src/lib.rs','renamed')])
if __name__=='__main__': unittest.main()
