#!/usr/bin/env python3
"""
Simulate WSJT-X UDP Decode (type 2) messages for testing pi-sat-track's
decode overlay. Sends to the WSJT-X listener (default 127.0.0.1:2237).

Usage:
  python3 tools/wsjtx_sim.py                       # loop built-in stations
  python3 tools/wsjtx_sim.py --host 192.168.1.50 --interval 3
  python3 tools/wsjtx_sim.py --once                # one pass and exit
  python3 tools/wsjtx_sim.py --msg "CQ SAT K1ABC FN42" --msg "W9XYZ K1ABC EN52"

Note: pi-sat-track only listens while Radio and Antenna are both on.
"""
import argparse
import random
import socket
import struct
import time
from datetime import datetime, timezone

MAGIC = 0xADBCCBDA
SCHEMA = 2
CLIENT_ID = "WSJT-X"

DEFAULT_MSGS = [
    "CQ SAT KA7KDX DN40",
    "CQ K1ABC FN42",
    "CQ DX W6XYZ CM97",
    "KA7KDX N0ABC EN34",
    "W5AAA VE3XYZ FN03",
    "CQ SAT XE1ABC EK09",
    "K1ABC W9XYZ RR73",      # no grid: should not plot
    "CQ JA1ABC PM95",
    "G4ABC EA4XYZ IN80",
]


def qstr(s):
    b = s.encode("utf-8")
    return struct.pack(">I", len(b)) + b


def header(msg_type):
    return struct.pack(">III", MAGIC, SCHEMA, msg_type) + qstr(CLIENT_ID)


def heartbeat():
    return header(0) + struct.pack(">I", 3) + qstr("2.7.0") + qstr("sim")


def decode(message, mode="~", snr=None, dt=None, df=None):
    now = datetime.now(timezone.utc)
    ms = ((now.hour * 60 + now.minute) * 60 + now.second) * 1000 + now.microsecond // 1000
    snr = random.randint(-20, 10) if snr is None else snr
    dt = round(random.uniform(-0.5, 1.5), 1) if dt is None else dt
    df = random.randint(300, 2700) if df is None else df
    return (
        header(2)
        + struct.pack(">?", True)          # new
        + struct.pack(">I", ms)            # QTime ms since midnight UTC
        + struct.pack(">i", snr)           # SNR dB
        + struct.pack(">d", dt)            # delta time s
        + struct.pack(">I", df)            # delta freq Hz
        + qstr(mode)                       # "~" = FT8, "+" = FT4
        + qstr(message)
        + struct.pack(">??", False, False) # low confidence, off air
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=2237)
    ap.add_argument("--interval", type=float, default=2.0, help="seconds between decodes")
    ap.add_argument("--mode", default="~", help='"~" FT8, "+" FT4')
    ap.add_argument("--msg", action="append", help="decode text (repeatable)")
    ap.add_argument("--once", action="store_true", help="send each message once and exit")
    a = ap.parse_args()

    msgs = a.msg or DEFAULT_MSGS
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dest = (a.host, a.port)
    print(f"Sending WSJT-X decodes to {a.host}:{a.port} (Ctrl-C to stop)")
    sock.sendto(heartbeat(), dest)
    try:
        while True:
            for m in msgs:
                sock.sendto(decode(m, a.mode), dest)
                print(f"{datetime.now():%H:%M:%S}  {m}")
                time.sleep(a.interval)
            if a.once:
                break
            sock.sendto(heartbeat(), dest)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
