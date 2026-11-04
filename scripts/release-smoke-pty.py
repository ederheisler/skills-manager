#!/usr/bin/env python3
"""Relay a command through a real PTY for the release smoke, not app runtime."""

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def write_all(fd: int, data: bytes) -> None:
    while data:
        written = os.write(fd, data)
        data = data[written:]


def main() -> int:
    if len(sys.argv) < 2:
        raise ValueError("Expected an executable and its arguments")

    child, master = pty.fork()
    if child == 0:
        try:
            fcntl.ioctl(sys.stdout.fileno(), termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
            os.execv(sys.argv[1], sys.argv[1:])
        except OSError as error:
            print(f"Cannot start PTY command: {error}", file=sys.stderr, flush=True)
            os._exit(127)

    def terminate(signum: int, _frame: object) -> None:
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGHUP, terminate)
    waited = False
    try:
        while True:
            readable, _, _ = select.select([sys.stdin.fileno(), master], [], [])
            if master in readable:
                try:
                    output = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
                if not output:
                    break
                write_all(sys.stdout.fileno(), output)
            if sys.stdin.fileno() in readable:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    raise RuntimeError("PTY input closed before the command exited")
                try:
                    write_all(master, data)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    break
        _, status = os.waitpid(child, 0)
        waited = True
        if os.WIFEXITED(status):
            return os.WEXITSTATUS(status)
        if os.WIFSIGNALED(status):
            return 128 + os.WTERMSIG(status)
        raise RuntimeError(f"Unexpected PTY child status: {status}")
    finally:
        if not waited:
            try:
                os.killpg(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(child, 0)
            except ChildProcessError:
                pass
        os.close(master)


if __name__ == "__main__":
    sys.exit(main())
