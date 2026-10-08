"""Bounded local readiness check, run inside the trusted RPC recorder container."""
import socket
import sys
import time


def wait_tcp(port=8080, timeout=30.0):
    if not 0 < port < 65536 or not 0 < timeout <= 60:
        raise ValueError('invalid readiness limit')
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('RPC recorder did not become ready before its deadline')
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=min(0.5, remaining)):
                return
        except OSError:
            # Do not emit arbitrary connection exception strings or credentials.
            time.sleep(min(0.2, max(0.0, deadline - time.monotonic())))


if __name__ == '__main__':
    if len(sys.argv) != 1:
        raise ValueError('readiness probe takes no arguments')
    wait_tcp()
