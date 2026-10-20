#!/usr/bin/env python3
"""
Bluetooth Classic RFCOMM (SPP) <-> stdin/stdout bridge for the KISS client
(lib/kiss/bluetooth.js). Uses only the Python standard library: Linux
CPython has AF_BLUETOOTH / BTPROTO_RFCOMM sockets (BlueZ kernel stack), so no
`rfcomm bind`, root or extra package is needed; the device must be paired.

  rfcomm-bridge.py <MAC> <channel> [connect-timeout-s]

Status goes to stderr, one line each:
  OK connected
  ERR <errno> <ERRNAME> <message>
Data: bytes from the radio -> stdout, stdin -> radio. Exits when the link
drops (radio off / out of range) or stdin closes (the app closed it); the
Node side reconnects with backoff.
"""
import errno
import os
import re
import select
import socket
import sys


def status(line):
    try:
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def err(code, name, msg):
    status("ERR %s %s %s" % (code, name, msg))


def oserr(e):
    n = e.errno if isinstance(e.errno, int) else 0
    err(n, errno.errorcode.get(n, "E?"), e.strerror or str(e))


def main(argv):
    if len(argv) < 3 or not re.match(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$", argv[1]):
        err(errno.EINVAL, "EINVAL", "usage: rfcomm-bridge.py <MAC aa:bb:cc:dd:ee:ff> <channel 1-30>")
        return 2
    mac = argv[1].upper()
    try:
        ch = int(argv[2])
    except ValueError:
        ch = 0
    if not 1 <= ch <= 30:
        err(errno.EINVAL, "EINVAL", "RFCOMM channel must be 1-30")
        return 2
    timeout = float(argv[3]) if len(argv) > 3 else 15.0
    if not hasattr(socket, "AF_BLUETOOTH") or not hasattr(socket, "BTPROTO_RFCOMM"):
        err(0, "ENOBTSOCK", "this Python has no Bluetooth socket support")
        return 3
    try:
        s = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM, socket.BTPROTO_RFCOMM)
    except OSError as e:
        oserr(e)
        return 3
    s.settimeout(timeout)
    try:
        s.connect((mac, ch))
    except socket.timeout:
        err(errno.ETIMEDOUT, "ETIMEDOUT", "connect timed out")
        return 4
    except OSError as e:
        oserr(e)
        return 4
    s.settimeout(None)
    status("OK connected")
    inp = sys.stdin.buffer.fileno()
    out = sys.stdout.buffer.fileno()
    try:
        while True:
            r, _, _ = select.select([s, inp], [], [])
            if s in r:
                d = s.recv(4096)
                if not d:
                    err(0, "EOF", "the radio closed the link")
                    return 5
                while d:
                    n = os.write(out, d)
                    d = d[n:]
            if inp in r:
                d = os.read(inp, 4096)
                if not d:
                    return 0  # the app closed stdin
                s.sendall(d)
    except OSError as e:
        oserr(e)
        return 5
    finally:
        try:
            s.close()
        except Exception:
            pass


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(0)
