#!/usr/bin/env python3
"""
Simple manager for two Green Heron RT-21 rotctld instances.

Usage:
  ./rt21_rotctld.py start
  ./rt21_rotctld.py stop
  ./rt21_rotctld.py status
"""

import subprocess
import os
import signal
import sys
import time
import socket

# ---- Configuration ----
AZ_DEVICE = "/dev/ttyUSB1"      # Azimuth
EL_DEVICE = "/dev/ttyUSB0"      # Elevation
AZ_PORT   = 4535
EL_PORT   = 4536
BAUD      = 4800
PID_FILE  = os.path.expanduser("~/.rt21_rotctld.pids")


def get_position(port):
    """Query a rotctld instance and return (az, el) or None on failure."""
    try:
        with socket.create_connection(("0.0.0.0", port), timeout=2) as sock:
            sock.sendall(b"p\n")
            data = sock.recv(128).decode().strip().splitlines()
            if len(data) >= 2:
                az = float(data[0])
                el = float(data[1])
                return az, el
    except Exception:
        pass
    return None


def start():
    if os.path.exists(PID_FILE):
        print("Already running? PID file exists. Run 'stop' first.")
        return

    print("Starting Azimuth rotctld on port", AZ_PORT)
    az = subprocess.Popen([
        "rotctld",
        "-m", "405",
        "-r", AZ_DEVICE,
        "-s", str(BAUD),
        "-T", "0.0.0.0",
        "-t", str(AZ_PORT),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print("Starting Elevation rotctld on port", EL_PORT)
    el = subprocess.Popen([
        "rotctld",
        "-m", "405",
        "-r", EL_DEVICE,
        "-s", str(BAUD),
        "-T", "0.0.0.0",
        "-t", str(EL_PORT),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    with open(PID_FILE, "w") as f:
        f.write(f"{az.pid}\n{el.pid}\n")

    time.sleep(0.8)
    print("Both rotctld instances started.")
    print(f"  Azimuth   → 0.0.0.0:{AZ_PORT}  (PID {az.pid})")
    print(f"  Elevation → 0.0.0.0:{EL_PORT}  (PID {el.pid})")


def stop():
    if not os.path.exists(PID_FILE):
        print("No PID file found. Nothing to stop.")
        return

    with open(PID_FILE) as f:
        pids = [int(line.strip()) for line in f if line.strip()]

    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
            print(f"Stopped PID {pid}")
        except ProcessLookupError:
            print(f"PID {pid} already gone")
        except Exception as e:
            print(f"Error stopping PID {pid}: {e}")

    os.remove(PID_FILE)
    print("Done.")


def status():
    if not os.path.exists(PID_FILE):
        print("Not running (no PID file).")
        return

    with open(PID_FILE) as f:
        pids = [int(line.strip()) for line in f if line.strip()]

    print("Process status:")
    alive = True
    for i, pid in enumerate(pids):
        name = "Azimuth" if i == 0 else "Elevation"
        try:
            os.kill(pid, 0)
            print(f"  {name:10} PID {pid} is running")
        except ProcessLookupError:
            print(f"  {name:10} PID {pid} is NOT running")
            alive = False

    if not alive:
        print("\nOne or both processes are dead. Consider running 'stop' then 'start'.")
        return

    print("\nCurrent position:")
    az_pos = get_position(AZ_PORT)
    el_pos = get_position(EL_PORT)

    if az_pos:
        print(f"  Azimuth   : {az_pos[0]:7.2f}°")
    else:
        print("  Azimuth   : (could not read)")

    if el_pos:
        print(f"  Elevation : {el_pos[0]:7.2f}°")   # model 405 returns az-like value for the single axis
    else:
        print("  Elevation : (could not read)")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("start", "stop", "status"):
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "start":
        start()
    elif cmd == "stop":
        stop()
    elif cmd == "status":
        status()
