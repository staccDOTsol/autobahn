import unittest
from unittest.mock import MagicMock, patch

from wait_tcp import wait_tcp


class RecorderReadinessTests(unittest.TestCase):
    @patch('wait_tcp.time.sleep')
    @patch('wait_tcp.time.monotonic', side_effect=[0.0, 0.0, 0.1, 0.3])
    @patch('wait_tcp.socket.create_connection')
    def test_retries_refused_connection_then_starts_capture(self, connect, clock, sleep):
        connect.side_effect = [ConnectionRefusedError('untrusted detail'), MagicMock()]
        wait_tcp(timeout=1)
        self.assertEqual(connect.call_count, 2)
        self.assertEqual(connect.call_args.args, (('127.0.0.1', 8080),))
        self.assertLessEqual(connect.call_args.kwargs['timeout'], 0.5)
        sleep.assert_called_once_with(0.2)

    @patch('wait_tcp.time.sleep')
    @patch('wait_tcp.time.monotonic', side_effect=[0.0, 0.9, 1.0, 1.0])
    @patch('wait_tcp.socket.create_connection', side_effect=OSError('secret upstream detail'))
    def test_deadline_is_bounded_and_error_does_not_echo_connection(self, connect, clock, sleep):
        with self.assertRaisesRegex(TimeoutError, '^RPC recorder did not become ready before its deadline$'):
            wait_tcp(timeout=1)
        self.assertAlmostEqual(connect.call_args.kwargs['timeout'], 0.1)
        self.assertEqual(connect.call_count, 1)
        sleep.assert_called_once_with(0.0)

    def test_rejects_unbounded_or_invalid_limits(self):
        for port, timeout in [(0, 1), (65536, 1), (8080, 0), (8080, 61)]:
            with self.subTest(port=port, timeout=timeout), self.assertRaises(ValueError):
                wait_tcp(port, timeout)
