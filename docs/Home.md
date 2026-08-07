# Pi Sat Track — Wiki

Satellite tracking, Doppler CAT, and rotator control for amateur radio.

This wiki is the operator guide. Source and installers live in the [repository](https://github.com/scubabri/pi-sat-track). Active development is on the **CAT** branch.

---

## Table of contents

1. [Overview](#1-overview)
2. [What you need](#2-what-you-need)
3. [Install](#3-install)
   - [Raspberry Pi / Linux](#31-raspberry-pi--linux)
   - [Windows 11](#32-windows-11)
   - [macOS](#33-macos)
4. [First launch](#4-first-launch)
5. [Configuration](#5-configuration)
   - [Profiles](#51-profiles)
   - [Single radio vs dual radio](#52-single-radio-vs-dual-radio)
   - [TX radio split](#53-tx-radio-split)
   - [Radio connection types](#54-radio-connection-types)
   - [Serial ports (COM / tty)](#55-serial-ports-com--tty)
   - [Rotator](#56-rotator)
6. [Connection tests](#6-connection-tests)
   - [Radio test](#61-radio-test)
   - [Rotator test](#62-rotator-test)
7. [Operating the tracker](#7-operating-the-tracker)
   - [Selecting a satellite](#71-selecting-a-satellite)
   - [Radio on / Antenna on](#72-radio-on--antenna-on)
   - [FM vs linear satellites](#73-fm-vs-linear-satellites)
   - [CTCSS](#74-ctcss)
   - [Fine offsets](#75-fine-offsets)
8. [Supported radios and rotors](#8-supported-radios-and-rotors)
9. [Cache and data files](#9-cache-and-data-files)
10. [Port 80 (Windows)](#10-port-80-windows)
11. [Uninstall (Windows)](#11-uninstall-windows)
12. [Troubleshooting](#12-troubleshooting)
13. [Planned wiki pages](#13-planned-wiki-pages)

---

## 1. Overview

**Pi Sat Track** is a Node.js web app that:

- Tracks amateur satellites (pass list, map, polar radar)
- Applies **Doppler correction** to uplink and downlink
- Drives radios over **serial CAT** or **TCP** (TCI, Flex, rigctl, SDRconnect)
- Drives rotators (**Green Heron RT-21**, **GS-232**-compatible)
- Stores **profiles**, favorites, and per-sat fine offsets

UI runs in a browser. The server runs on the machine that owns the serial ports (typically a Raspberry Pi), or on a Windows/macOS PC for TCP radios and local COM ports.

---

## 2. What you need

| Item | Notes |
|------|--------|
| Host computer | Raspberry Pi (recommended), Linux, Windows 11, or macOS |
| Node.js LTS | Installed by Windows installer if missing; manual on Pi/Mac |
| Browser | Any modern browser on the LAN or localhost |
| Radio path (optional) | Serial CAT cable and/or network SDR/CAT (TCI, etc.) |
| Rotator (optional) | RT-21 (AZ+EL ports) or GS-232-style controller |

Internet is used for AMSAT catalog / Celestrak TLE refresh; after that, tracking can continue offline with cached data.

---

## 3. Install

### 3.1 Raspberry Pi / Linux

Distribution is a **zip / self-extracting archive** (not a git clone requirement for alpha testers).

```bash
# After extract into ~/pi-sat-track (or similar)
cd ~/pi-sat-track
chmod +x install-pi.sh
./install-pi.sh
```

The Pi installer sets up Node dependencies, cache under `~/.rpitrack`, and optionally nginx and a user service. See the repo `README.md` for flags (`--no-nginx`, `--update`, etc.).

### 3.2 Windows 11

1. Unzip the release into e.g. `%USERPROFILE%\\pi-sat-track`
2. **Right-click `install-win.bat` → Run as administrator**
3. If Node.js is missing, accept the prompt to install **Node.js LTS**
4. When finished, start with `start-sat-tracker.bat` or `node server.js`

**Administrator is required** for:

- Optional Node MSI / winget install  
- Port **80** proxy + firewall rule (if port 80 is free)

If port 80 is already in use, the installer leaves it alone; use **http://127.0.0.1:3000**.

### 3.3 macOS

No dedicated installer yet. Install [Node.js LTS](https://nodejs.org/), then:

```bash
cd /path/to/pi-sat-track
npm install
node server.js
```

Open **http://127.0.0.1:3000**. Serial devices appear as `/dev/cu.usb*` (not Linux `ttyUSB`).

---

## 4. First launch

1. Start the server (`node server.js` or the Windows launcher).
2. Open the UI: `http://127.0.0.1:3000` (or port 80 on Windows if the proxy was enabled).
3. Open **Config** (gear).
4. Set location (grid or lat/lon) if prompted by your profile flow.
5. Configure **radio** and/or **rotor**, then **Save**.
6. Use **Test radio** / **Test rotor** before a pass.

Cache and profiles are stored under:

| OS | Cache directory |
|----|-----------------|
| Linux / Pi | `~/.rpitrack` |
| macOS | `~/.rpitrack` |
| Windows | `%USERPROFILE%\\.rpitrack` |

---

## 5. Configuration

### 5.1 Profiles

Profiles store a full setup (radios, rotor, endpoints). Switch profiles from the UI; active profile is restored on restart.

### 5.2 Single radio vs dual radio

- **Single radio** — one radio path for TX/RX (or RX-only). Second radio (DL) options are hidden.
- **Dual radio** — separate UL (TX) and DL (RX) paths (e.g. FT-817 uplink + SDR downlink).

### 5.3 TX radio split

When enabled on a dual-VFO radio, uplink can use **VFO B** (or the driver's split behavior).  

**Note:** Some radios (e.g. FT-817) only support **FM split with locked uplink** reliably; linear Doppler split on a single 817 is not supported the same way as full-duplex CAT radios.

### 5.4 Radio connection types

| Type | Typical use |
|------|-------------|
| **Serial CAT** | Yaesu / Icom / Kenwood over USB-serial |
| **TCI** | AetherSDR / ExpertSDR WebSocket |
| **Flex** | SmartSDR CAT TCP |
| **rigctl** | Hamlib |
| **SDRconnect** | SDRplay SDRconnect WebSocket |

Manufacturer **Other** drivers exist for try-it serial where a specific model driver is not listed yet.

### 5.5 Serial ports (COM / tty)

| OS | Device names |
|----|----------------|
| Linux / Pi | `/dev/ttyUSB0`, `/dev/ttyACM0`, … |
| Windows | `COM3`, `COM5`, … |
| macOS | `/dev/cu.usbserial-…`, `/dev/cu.usbmodem-…` |

The config dropdown lists **discovered** ports. Names alone do not identify the radio brand—use Device Manager (Windows) or plug/unplug to see which port appears, then use **Test radio**.

*(Screenshot placeholders for the future wiki: Device Manager before/after plug-in, config serial dropdown.)*

### 5.6 Rotator

| Driver | Ports |
|--------|--------|
| **RT-21** (Green Heron) | Separate AZ and EL serial devices |
| **GS-232** | Single serial device |

Options:

- **AZ only** — fixed-elevation mounts; no EL commands  
- **180° elevation** — for rotators that support over-the-top  
- **Park AZ / EL** — parking position  

Turn **Antenna OFF** in the UI before running the rotator connection test so the port is free.

---

## 6. Connection tests

### 6.1 Radio test

Config → **Test radio** (or Test UL / Test DL in dual mode):

1. Connects with the selected transport  
2. Reads frequency / mode when the protocol supports it  
3. Shows a confirmation dialog — compare to the radio display  

Serial success example: frequency + mode from CAT.  
TCI: WebSocket probe; VFO data if the SDR is streaming.

### 6.2 Rotator test

Guided steps:

1. Read AZ → confirm  
2. Nudge AZ ~10° → confirm  
3. Return AZ → confirm  
4. Same for EL (unless AZ only)  

Live position is shown on the **rotor gauges** during the test. Keep **Antenna OFF** before starting so the test can open the serial ports.

---

## 7. Operating the tracker

### 7.1 Selecting a satellite

Use the satellite menu / favorites / pass list. Catalog frequencies and modes come from AMSAT data when available; TLEs from Celestrak (cached).

### 7.2 Radio on / Antenna on

- **Radio** — enables CAT/Doppler to the configured radio(s)  
- **Antenna** — enables rotator tracking  

Enable after config tests pass.

### 7.3 FM vs linear satellites

| | FM (e.g. SO-50) | Linear (e.g. RS-44) |
|--|-----------------|---------------------|
| Uplink | Often **fixed** (UL lock) | Doppler-tracked when the radio supports it |
| Downlink | Doppler on RX | Doppler on RX |
| FT-817 split | FM split with locked UL supported | Split Doppler not used the same way; single VFO / dual radio paths |

### 7.4 CTCSS

Access / activation tones follow catalog data when present. Drivers apply tone where the radio API supports it (UI-only for some SDR paths).

### 7.5 Fine offsets

Per-satellite UL/DL fine offsets persist under the cache directory (`sat-offsets.json`) so small calibration errors survive restarts.

---

## 8. Supported radios and rotors

**Serial CAT (examples):** FT-817/818, FT-847, FT-991, IC-705, IC-9700, TS-2000, plus manufacturer "Other" try-drivers.

**Network:** TCI (AetherSDR), Flex SmartSDR CAT, Hamlib rigctl, SDRplay SDRconnect.

**Rotors:** Green Heron RT-21, GS-232-compatible.

Exact capability (split, CTCSS, speed) varies by radio—use connection test after setup.

---

## 9. Cache and data files

Under `~/.rpitrack` (or `%USERPROFILE%\\.rpitrack` on Windows):

- AMSAT catalog / status cache  
- TLE files  
- `sat-offsets.json`  
- Profiles  
- Windows only: `.node-installed-by-sat-tracker` marker if the installer auto-installed Node  

---

## 10. Port 80 (Windows)

When `install-win.bat` runs as Administrator and port 80 is free, it adds:

- **netsh portproxy**: `0.0.0.0:80` → `127.0.0.1:3000`  
- Firewall rule: **Pi Sat Track HTTP 80**

Then both work:

- http://127.0.0.1:3000  
- http://127.0.0.1/  

Uninstall (as Administrator) removes the proxy and firewall rule.

---

## 11. Uninstall (Windows)

```text
uninstall-win.bat
```

Always removes `node_modules` and the start launcher (after confirmation).

| Flag | Effect |
|------|--------|
| `--cache` / `--all` | Also delete `%USERPROFILE%\\.rpitrack` |
| `--remove-node` | Offer to uninstall Node.js |
| `--purge` | Also delete the app folder |

If the installer auto-installed Node, uninstall **offers** to remove Node (type `YES`). Node is never removed silently.

---

## 12. Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| UI not loading | Server running? Correct host/port? Firewall? |
| Serial open failed / port busy | Antenna OFF; close other CAT software; correct COM/tty |
| Radio test fails | Baud, CI-V address (Icom), cable, CAT rate menu on radio |
| TCI test connects but no frequency | SDR app running and VFO streaming |
| Rotator test timeout | Ports not swapped; Antenna OFF; correct AZ vs EL device |
| Wrong serial path after moving Pi → PC | Re-select COM ports; Linux `/dev` paths are invalid on Windows |
| Doppler wrong sideband | Mode (USB/LSB) and inverting transponder settings for that sat |

---

## 13. Planned wiki pages

Placeholder index for pages to expand with screenshots:

| Page | Content |
|------|---------|
| [Install — Raspberry Pi](Install-Raspberry-Pi) | Full `install-pi.sh` walkthrough |
| [Install — Windows](Install-Windows) | Admin install, Node, port 80 |
| [Finding your serial port](Serial-Ports) | Device Manager / `dmesg` / plug-unplug |
| [Radio setup](Radio-Setup) | Serial CAT, TCI, dual radio, split |
| [Rotator setup](Rotator-Setup) | RT-21 dual port, GS-232, AZ only, 180° |
| [Connection tests](Connection-Tests) | Radio confirm dialog, rotor guided test |
| [FT-817 notes](FT-817) | FM split, UL lock, limitations |
| [Profiles and offsets](Profiles) | Saving setups, fine tune |
| [Troubleshooting](Troubleshooting) | Expanded FAQ |

---

*Pi Sat Track — alpha documentation. Screenshots and platform-specific pages will be added as the wiki grows.*
