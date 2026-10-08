import unittest
from unittest.mock import patch
from admission_queue import dispatch_current

def pr(head='a', base='b'):
    return {'head': {'sha': head}, 'base': {'sha': base, 'ref': 'main'}}

class QueueTests(unittest.TestCase):
    @patch('admission_queue.github')
    @patch('admission_queue.read_pr', return_value=(pr(), ['dbc']))
    def test_current_base_dispatches_without_review_gate(self, read, api):
        api.return_value = {'behind_by': 0}
        dispatch_current('owner/repo', 1)
        self.assertEqual(api.call_args.args[2]['inputs'], {'pr': '1', 'sha': 'a', 'base': 'b'})

    @patch('admission_queue.time.sleep')
    @patch('admission_queue.github')
    @patch('admission_queue.read_pr')
    def test_refreshes_behind_branch_before_testing(self, read, api, sleep):
        read.side_effect = [(pr(), ['dbc']), (pr('c'), ['dbc']), (pr('c'), ['dbc'])]
        api.side_effect = [{'behind_by': 1}, {}, {'behind_by': 0}, {}]
        dispatch_current('owner/repo', 1)
        self.assertEqual(api.call_args_list[1].args[2], {'expected_head_sha': 'a'})
        self.assertEqual(api.call_args.args[2]['inputs']['sha'], 'c')
