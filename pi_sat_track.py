#!/usr/bin/env python3
"""
Satellite Tracker for Raspberry Pi
Dynamic TLE (Celestrak) + frequencies (AMSAT), cached in ~/.rpitrack

Usage:
  pi_sat_track.py RS-44
  pi_sat_track.py AO-07
  pi_sat_track.py FO-29
  pi_sat_track.py JO-97

Keys: R=radio  A=antenna  digits=step  +/-=UL  C=centre  q=quit
"""

import argparse
import asyncio
import curses
import json
import os
import re
import socket
import time
import urllib.request
from datetime import datetime, timezone, timedelta
from skyfield.api import load, wgs84, EarthSatellite
import websockets

# ---------- Station ----------
LAT, LON, ELEV_M = 40.5, -111.9, 1324

# ---------- Network config ----------
# Mac running AetherSDR (TCI) — set to Mac LAN IP when running on the Pi
MAC_IP = "172.17.18.117"              # <-- edit me
TCI_URI = f"ws://{MAC_IP}:50001"

# Rotor on this Pi
PI_IP = "127.0.0.1"
AZ_PORT, EL_PORT = 4535, 4536

MIN_EL = 10.0
ROTOR_UPDATE_INTERVAL = 30.0
C = 299792458.0
EDGE_MARGIN = 5e3
YELLOW_SEC = 30 * 60
RED_SEC = 5 * 60

CACHE_DIR = os.path.expanduser("~/.rpitrack")
AMSAT_URL = "https://www.amsat.org/live-linear-satellites/"
CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php?CATNR={norad}&FORMAT=TLE"

FALLBACK = {
    "RS-44": {
        "norad": 44909, "name": "RS-44",
        "ul_low": 145.935e6, "ul_high": 145.995e6,
        "dl_low": 435.610e6, "dl_high": 435.670e6,
        "inverting": True,
    },
    "AO-07": {
        "norad": 7530, "name": "AO-07 Mode B",
        "ul_low": 432.125e6, "ul_high": 432.175e6,
        "dl_low": 145.925e6, "dl_high": 145.975e6,
        "inverting": True,
    },
    "FO-29": {
        "norad": 24278, "name": "FO-29",
        "ul_low": 145.900e6, "ul_high": 146.000e6,
        "dl_low": 435.800e6, "dl_high": 435.900e6,
        "inverting": True,
    },
    "JO-97": {
        "norad": 43803, "name": "JO-97 (JY1SAT)",
        "ul_low": 435.100e6, "ul_high": 435.120e6,
        "dl_low": 145.855e6, "dl_high": 145.875e6,
        "inverting": True,
    },
}

AMSAT_MATCH = {
    "RS-44": ["RS-44"],
    "AO-07": ["AO-7 Mode B", "AO-07 Mode B"],
    "FO-29": ["FO-29"],
    "JO-97": ["JO-97", "JY1Sat", "JY1SAT"],
}


def ensure_cache_dir():
    os.makedirs(CACHE_DIR, exist_ok=True)


def cache_age_str(iso_ts):
    try:
        then = datetime.fromisoformat(iso_ts)
        if then.tzinfo is None:
            then = then.replace(tzinfo=timezone.utc)
        age = datetime.now(timezone.utc) - then
        secs = int(age.total_seconds())
        if secs < 60:
            return f"{secs}s"
        if secs < 3600:
            return f"{secs // 60}m"
        if secs < 86400:
            return f"{secs // 3600}h"
        return f"{secs // 86400}d"
    except Exception:
        return "?"


def parse_amsat_html(html):
    """Parse AMSAT live linear page. Decodes &#8211; etc."""
    text = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.I | re.S)
    text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", "\n", text)

    # Decode numeric HTML entities (&#8211; en-dash is critical)
    text = re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), text)
    text = re.sub(r"&#x([0-9a-fA-F]+);", lambda m: chr(int(m.group(1), 16)), text)
    text = text.replace("&nbsp;", " ")
    text = re.sub(r"&[a-z]+;", " ", text, flags=re.I)

    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n+", "\n", text)

    results = {}
    parts = re.split(
        r"\n\s*((?:AO-7|AO-73|FO-29|JO-97|RS-44|TO-108|QO-100|CatSat)[^\n]*)",
        text,
        flags=re.I,
    )
    i = 1
    while i + 1 < len(parts):
        title = parts[i].strip()
        body = parts[i + 1]
        i += 2
        ul = re.search(
            r"Uplink\s+(?:LSB|USB)\s*:\s*([\d.]+)\s*MHz\s*[–\-\u2013\u2014]\s*([\d.]+)\s*MHz",
            body, re.I,
        )
        dl = re.search(
            r"Downlink\s+(?:LSB|USB)\s*:\s*([\d.]+)\s*MHz\s*[–\-\u2013\u2014]\s*([\d.]+)\s*MHz",
            body, re.I,
        )
        if not ul or not dl:
            continue
        inv = bool(re.search(r"Inverting", body, re.I))
        results[title] = {
            "ul_low": float(ul.group(1)) * 1e6,
            "ul_high": float(ul.group(2)) * 1e6,
            "dl_low": float(dl.group(1)) * 1e6,
            "dl_high": float(dl.group(2)) * 1e6,
            "inverting": inv,
        }
    return results


def fetch_amsat_freqs():
    ensure_cache_dir()
    path = os.path.join(CACHE_DIR, "amsat_freqs.json")
    err = None
    try:
        req = urllib.request.Request(AMSAT_URL, headers={"User-Agent": "sat_tracker/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")
        parsed = parse_amsat_html(html)
        out = {}
        for cli, keys in AMSAT_MATCH.items():
            for title, data in parsed.items():
                if any(k.lower() in title.lower() for k in keys):
                    out[cli] = {
                        **data,
                        "name": title,
                        "norad": FALLBACK[cli]["norad"],
                    }
                    break
        if out:
            payload = {
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "satellites": out,
            }
            with open(path, "w") as f:
                json.dump(payload, f, indent=2)
            return out, "AMSAT live (just fetched)"
        err = "parser matched 0 satellites"
    except Exception as e:
        err = str(e)

    if os.path.exists(path):
        with open(path) as f:
            payload = json.load(f)
        age = cache_age_str(payload.get("fetched_at", ""))
        note = f"AMSAT cache age {age}"
        if err:
            note += f" (fetch failed: {err[:50]})"
        return payload.get("satellites", {}), note

    note = "built-in defaults (no AMSAT cache)"
    if err:
        note += f" (fetch failed: {err[:50]})"
    return {k: dict(v) for k, v in FALLBACK.items()}, note


def fetch_tle(norad):
    ensure_cache_dir()
    path = os.path.join(CACHE_DIR, f"tle_{norad}.txt")
    meta_path = os.path.join(CACHE_DIR, f"tle_{norad}.meta.json")
    err = None

    try:
        url = CELESTRAK_URL.format(norad=norad)
        req = urllib.request.Request(url, headers={"User-Agent": "sat_tracker/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            text = resp.read().decode("utf-8", errors="replace").strip()
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        if len(lines) >= 2:
            if lines[0].startswith("1 "):
                name = f"NORAD {norad}"
                l1, l2 = lines[0], lines[1]
            else:
                name = lines[0]
                l1, l2 = lines[1], lines[2]
            with open(path, "w") as f:
                f.write(f"{name}\n{l1}\n{l2}\n")
            meta = {"fetched_at": datetime.now(timezone.utc).isoformat(), "name": name}
            with open(meta_path, "w") as f:
                json.dump(meta, f)
            ts = load.timescale()
            return EarthSatellite(l1, l2, name, ts), "Celestrak (just fetched)"
    except Exception as e:
        err = str(e)

    if os.path.exists(path):
        with open(path) as f:
            lines = [ln.strip() for ln in f if ln.strip()]
        name, l1, l2 = lines[0], lines[1], lines[2]
        ts = load.timescale()
        age = "?"
        if os.path.exists(meta_path):
            with open(meta_path) as f:
                meta = json.load(f)
            age = cache_age_str(meta.get("fetched_at", ""))
        note = f"TLE cache age {age}"
        if err:
            note += f" (fetch failed: {err[:50]})"
        return EarthSatellite(l1, l2, name, ts), note

    raise RuntimeError(f"No TLE for NORAD {norad} and no cache ({err})")


def doppler_factor(rr):
    return 1.0 - (rr * 1000.0 / C)


def fmt_freq(hz):
    hz = int(round(hz))
    return f"{hz//1_000_000}.{hz%1_000_000//1000:03d}.{hz%1000:03d}"


def rotctl_cmd(port, cmd):
    try:
        with socket.create_connection((PI_IP, port), timeout=2) as s:
            s.sendall((cmd + "\n").encode())
            return s.recv(128).decode().strip()
    except Exception as e:
        return str(e)


def set_rotor(az, el):
    rotctl_cmd(AZ_PORT, f"P {az:.1f} 0.0")
    rotctl_cmd(EL_PORT, f"P {el:.1f} 0.0")


def find_passes(sat, observer, ts, min_el=MIN_EL, hours=12):
    passes = []
    t = ts.now()
    end = ts.utc(t.utc_datetime() + timedelta(hours=hours))
    prev_el = None
    aos_t = aos_az = None
    while t.tt < end.tt:
        topo = (sat - observer).at(t)
        alt, az, _ = topo.altaz()
        el = alt.degrees
        if prev_el is not None:
            if prev_el < min_el <= el:
                aos_t, aos_az = t, az.degrees
            elif prev_el >= min_el > el and aos_t is not None:
                max_el = min_el
                tscan = aos_t
                while tscan.tt < t.tt:
                    e = (sat - observer).at(tscan).altaz()[0].degrees
                    if e > max_el:
                        max_el = e
                    tscan = ts.utc(tscan.utc_datetime() + timedelta(seconds=30))
                passes.append((aos_t, t, max_el, aos_az))
                aos_t = aos_az = None
        prev_el = el
        t = ts.utc(t.utc_datetime() + timedelta(seconds=30))
    return passes



def fmt_countdown(seconds):
    if seconds < 0:
        return "---"
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def band_colour(freq, low, high, green, yellow, red):
    if freq < low or freq > high:
        return red
    if freq < low + EDGE_MARGIN or freq > high - EDGE_MARGIN:
        return yellow
    return green


async def tci_send(ws, cmd):
    await ws.send(cmd)
    await asyncio.sleep(0.05)


async def tracker(stdscr, sat_key):
    ensure_cache_dir()
    stdscr.addstr(0, 0, "Loading AMSAT frequencies and TLE…")
    stdscr.refresh()

    all_freqs, freq_note = fetch_amsat_freqs()
    if sat_key not in all_freqs:
        all_freqs[sat_key] = dict(FALLBACK[sat_key])
        freq_note += " [using built-in for this sat]"

    cfg = all_freqs[sat_key]
    UL_LOW, UL_HIGH = cfg["ul_low"], cfg["ul_high"]
    DL_LOW, DL_HIGH = cfg["dl_low"], cfg["dl_high"]
    UL_NOM = (UL_LOW + UL_HIGH) / 2
    DL_NOM = (DL_LOW + DL_HIGH) / 2
    INVERTING = cfg.get("inverting", True)
    NORAD = cfg.get("norad", FALLBACK[sat_key]["norad"])
    DISPLAY_NAME = cfg.get("name", sat_key)

    sat, tle_note = fetch_tle(NORAD)
    tle_name = sat.name
    ts = load.timescale()
    observer = wgs84.latlon(LAT, LON, elevation_m=ELEV_M)

    curses.curs_set(0)
    stdscr.nodelay(True)
    stdscr.timeout(100)
    curses.start_color()
    curses.use_default_colors()
    curses.init_pair(1, curses.COLOR_GREEN,  -1)
    curses.init_pair(2, curses.COLOR_YELLOW, -1)
    curses.init_pair(3, curses.COLOR_RED,    -1)
    curses.init_pair(4, curses.COLOR_CYAN,   -1)
    curses.init_pair(5, curses.COLOR_WHITE,  -1)
    GREEN  = curses.color_pair(1) | curses.A_BOLD
    YELLOW = curses.color_pair(2) | curses.A_BOLD
    RED    = curses.color_pair(3) | curses.A_BOLD
    CYAN   = curses.color_pair(4) | curses.A_BOLD
    NORMAL = curses.color_pair(5)

    passes = find_passes(sat, observer, ts, MIN_EL)
    next_pass = passes[0] if passes else None

    radio_on = False
    antenna_on = False
    ws = None
    last_cmd_dl = int(DL_NOM)
    last_cmd_ul = int(UL_NOM)
    manual_dl_offset = 0.0
    ul_fine_offset = 0.0
    digit_buffer = ""
    step_applied = False
    rise_az = next_pass[3] if next_pass else 0.0
    below = True
    target_az, target_el = rise_az, MIN_EL
    last_rotor = 0.0
    df = 1.0
    sat_az = sat_el = dist_km = 0.0

    while True:
        try:
            ch = stdscr.getch()
            if ch in (ord("q"), ord("Q")):
                break
            elif ch in (ord("r"), ord("R")):
                if radio_on and ws is not None:
                    try:
                        await ws.close()
                    except Exception:
                        pass
                    ws = None
                    radio_on = False
                else:
                    try:
                        ws = await websockets.connect(TCI_URI, open_timeout=3)
                        end = time.monotonic() + 1.5
                        while time.monotonic() < end:
                            try:
                                await asyncio.wait_for(ws.recv(), timeout=0.2)
                            except asyncio.TimeoutError:
                                break
                        radio_on = True
                        manual_dl_offset = 0.0
                        ul_fine_offset = 0.0
                    except Exception:
                        radio_on = False
                        ws = None
            elif ch in (ord("a"), ord("A")):
                antenna_on = not antenna_on
                if antenna_on:
                    last_rotor = 0.0
            elif ch in (ord("c"), ord("C")):
                manual_dl_offset = 0.0
                ul_fine_offset = 0.0
                digit_buffer = ""
                step_applied = False
            elif ch in (ord("+"), ord("=")):
                step = int(digit_buffer) if digit_buffer else 10
                ul_fine_offset += step
                step_applied = True
            elif ch == ord("-"):
                step = int(digit_buffer) if digit_buffer else 10
                ul_fine_offset -= step
                step_applied = True
            elif ch in (ord("0"), ord("1"), ord("2"), ord("3"), ord("4"),
                        ord("5"), ord("6"), ord("7"), ord("8"), ord("9")):
                if step_applied:
                    digit_buffer = chr(ch)
                    step_applied = False
                else:
                    digit_buffer += chr(ch)
                    if len(digit_buffer) > 5:
                        digit_buffer = digit_buffer[-5:]
            elif ch in (curses.KEY_BACKSPACE, 127, 8):
                digit_buffer = digit_buffer[:-1]
                step_applied = False
        except Exception:
            pass

        t = ts.now()
        topo = (sat - observer).at(t)
        alt, az, dist, _, _, rr = topo.frame_latlon_and_rates(observer)
        df = doppler_factor(rr.km_per_s)
        sat_az, sat_el = az.degrees, alt.degrees
        dist_km = dist.km

        if radio_on and ws is not None:
            reported_dl = None
            try:
                while True:
                    msg = await asyncio.wait_for(ws.recv(), timeout=0.01)
                    if msg.startswith("vfo:") and int(msg.split(":")[1].split(",")[0]) == 0:
                        reported_dl = int(msg.strip(";").split(",")[2])
            except asyncio.TimeoutError:
                pass
            except Exception:
                radio_on = False
                ws = None

            if reported_dl and abs(reported_dl - last_cmd_dl) > 80:
                manual_dl_offset = reported_dl - (DL_NOM * df)

            if INVERTING:
                desired_dl = int(round(DL_NOM * df + manual_dl_offset))
                desired_ul = int(round(UL_NOM * (2.0 - df) - manual_dl_offset + ul_fine_offset))
            else:
                desired_dl = int(round(DL_NOM * df + manual_dl_offset))
                desired_ul = int(round(UL_NOM * df + manual_dl_offset + ul_fine_offset))

            try:
                if abs(desired_dl - last_cmd_dl) >= 1:
                    await tci_send(ws, f"vfo:0,0,{desired_dl};")
                    last_cmd_dl = desired_dl
                if abs(desired_ul - last_cmd_ul) >= 1:
                    await tci_send(ws, f"vfo:1,0,{desired_ul};")
                    last_cmd_ul = desired_ul
            except Exception:
                radio_on = False
                ws = None
        else:
            if INVERTING:
                last_cmd_dl = int(round(DL_NOM * df + manual_dl_offset))
                last_cmd_ul = int(round(UL_NOM * (2.0 - df) - manual_dl_offset + ul_fine_offset))
            else:
                last_cmd_dl = int(round(DL_NOM * df + manual_dl_offset))
                last_cmd_ul = int(round(UL_NOM * df + manual_dl_offset + ul_fine_offset))

        if sat_el < MIN_EL:
            if not below:
                passes = find_passes(sat, observer, ts, MIN_EL)
                next_pass = passes[0] if passes else None
                rise_az = next_pass[3] if next_pass else sat_az
                below = True
            desired_az, desired_el = rise_az, MIN_EL
        else:
            below = False
            desired_az, desired_el = sat_az, sat_el

        if antenna_on and (time.monotonic() - last_rotor >= ROTOR_UPDATE_INTERVAL):
            set_rotor(desired_az, desired_el)
            target_az, target_el = desired_az, desired_el
            last_rotor = time.monotonic()
        elif not antenna_on:
            target_az, target_el = desired_az, desired_el

        pass_attr = GREEN
        status = "Waiting"
        if next_pass:
            aos_t, los_t, max_el, aos_az = next_pass
            aos_utc = aos_t.utc_datetime().replace(tzinfo=timezone.utc)
            los_utc = los_t.utc_datetime().replace(tzinfo=timezone.utc)
            sec_to_aos = (aos_utc - datetime.now(timezone.utc)).total_seconds()
            sec_to_los = (los_utc - datetime.now(timezone.utc)).total_seconds()
            if sec_to_aos > YELLOW_SEC:
                pass_attr = GREEN
                status = f"Next AOS in {fmt_countdown(sec_to_aos)}"
            elif sec_to_aos > RED_SEC:
                pass_attr = YELLOW
                status = f"Approaching – AOS in {fmt_countdown(sec_to_aos)}"
            elif sec_to_aos > 0:
                pass_attr = RED
                status = f"IMMINENT – AOS in {fmt_countdown(sec_to_aos)}"
            elif sec_to_los > 0:
                pass_attr = RED
                status = f"IN PASS – LOS in {fmt_countdown(sec_to_los)}"
            else:
                pass_attr = YELLOW
                status = "Pass ended – refreshing…"
                passes = find_passes(sat, observer, ts, MIN_EL)
                next_pass = passes[0] if passes else None

        stdscr.erase()
        h, w = stdscr.getmaxyx()

        def put(y, x, text, attr=NORMAL):
            if 0 <= y < h and 0 <= x < w:
                stdscr.addnstr(y, x, text, max(0, w - x - 1), attr)

        now_utc = datetime.now(timezone.utc)
        now_local = datetime.now().astimezone()

        put(0, 0, f" {sat_key} Tracker  │  {DISPLAY_NAME}  (NORAD {NORAD})", CYAN)
        put(1, 0, f"TLE: {tle_name}  │  {tle_note}")
        put(2, 0, f"Freq: {freq_note}")
        put(3, 0, f"TCI: {TCI_URI}")
        put(4, 0, f"UTC  {now_utc.strftime('%Y-%m-%d %H:%M:%S')}    "
                  f"Local {now_local.strftime('%Y-%m-%d %H:%M:%S %Z')}")

        radio_txt = "Radio ON " if radio_on else "Radio OFF"
        ant_txt = "Antenna ON " if antenna_on else "Antenna OFF"
        put(5, 0, f" {radio_txt}  [R]    {ant_txt}  [A]",
            GREEN if radio_on else YELLOW)

        put(7, 0, "── Next Pass (AOS/LOS at 10°) ─────────────────────────", CYAN)
        if next_pass:
            aos_t, los_t, max_el, aos_az = next_pass
            aos_utc = aos_t.utc_datetime().replace(tzinfo=timezone.utc)
            los_utc = los_t.utc_datetime().replace(tzinfo=timezone.utc)
            aos_local = aos_utc.astimezone()
            los_local = los_utc.astimezone()
            put(8, 2, f"AOS  UTC {aos_utc.strftime('%H:%M:%S')}   "
                      f"Local {aos_local.strftime('%H:%M:%S %Z')}   Az {aos_az:5.1f}°", pass_attr)
            put(9, 2, f"LOS  UTC {los_utc.strftime('%H:%M:%S')}   "
                      f"Local {los_local.strftime('%H:%M:%S %Z')}", pass_attr)
            put(10, 2, f"Max Elevation  {max_el:5.1f}°", pass_attr)
            put(11, 2, status, pass_attr)
        else:
            put(8, 2, "No pass found in next 12 hours", YELLOW)

        put(13, 0, "── Live Geometry ──────────────────────────────────────", CYAN)
        put(14, 2, f"Satellite  Az {sat_az:6.1f}°   El {sat_el:6.1f}°   Dist {dist_km:6.0f} km")
        rotor_txt = f"Rotor      Az {target_az:6.1f}°   El {target_el:6.1f}°"
        if not antenna_on:
            rotor_txt += "   (antenna off)"
        elif below:
            rotor_txt += "   (parked)"
        else:
            rotor_txt += "   (tracking)"
        put(15, 2, rotor_txt, YELLOW if (below or not antenna_on) else GREEN)

        put(17, 0, "── Radio (TCI) ────────────────────────────────────────", CYAN)
        dl_dop = (df - 1.0) * DL_NOM / 1e6
        ul_dop = ((1.0 - df) if INVERTING else (df - 1.0)) * UL_NOM / 1e6
        dl_attr = band_colour(last_cmd_dl, DL_LOW, DL_HIGH, GREEN, YELLOW, RED)
        ul_attr = band_colour(last_cmd_ul, UL_LOW, UL_HIGH, GREEN, YELLOW, RED)
        put(18, 2, f"Downlink  {fmt_freq(last_cmd_dl)}    Doppler {dl_dop:+.6f} MHz", dl_attr)
        put(19, 2, f"Uplink    {fmt_freq(last_cmd_ul)}    Doppler {ul_dop:+.6f} MHz", ul_attr)
        put(20, 2, f"DL offset  {manual_dl_offset:+.1f} Hz  ({manual_dl_offset/1e6:+.6f} MHz)")
        put(21, 2, f"UL fine    {ul_fine_offset:+.1f} Hz    step [{digit_buffer or '10'}]")
        put(22, 2, f"Passband DL {DL_LOW/1e6:.3f}-{DL_HIGH/1e6:.3f}   "
                   f"UL {UL_LOW/1e6:.3f}-{UL_HIGH/1e6:.3f}")

        put(h - 2, 0, " R=radio  A=antenna  digits=step  +/-=UL  C=centre  q=quit ", CYAN)
        stdscr.refresh()
        await asyncio.sleep(1.0)

    if ws is not None:
        try:
            await ws.close()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="Satellite Doppler + rotor tracker")
    parser.add_argument(
        "satellite",
        choices=list(FALLBACK.keys()),
        help="Satellite: RS-44, AO-07, FO-29, JO-97",
    )
    args = parser.parse_args()

    def _run(stdscr):
        asyncio.run(tracker(stdscr, args.satellite))

    curses.wrapper(_run)


if __name__ == "__main__":
    main()
