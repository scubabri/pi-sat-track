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
   - [Hamlib (rigctld)](#57-hamlib-rigctld)
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

**Option A: setup.exe (recommended).** Download `pi-sat-track-<branch>-alpha.<N>-setup.exe` from https://pi-sat-track.s3.amazonaws.com/ and run it (UAC prompt).

- **Node.js:** if Node.js 22+ is missing (or older), the *Ready to Install* page lists **Node.js 22 LTS (will be downloaded and installed)**. Setup downloads the official MSI from nodejs.org, checks its SHA-256, and installs it silently. A newer Node.js is never touched. If the download or the install fails (e.g. *another installation is in progress*), setup stops before changing anything; the Node install log is `%TEMP%\\pi-sat-track-node-install.log`.
- **Install:** to `C:\\Program Files\\Pi Sat Track`. Node packages are already inside the exe; no `npm` step and no internet needed after Node.js. It also sets up port 80 and the firewall (section 10).
- **Shortcuts:** Start Menu **Start / Stop / Open / Uninstall Pi Sat Track**, plus an *Apps → Installed apps* entry. There is no service and no auto start.
- **Troubleshooting:** run setup with `/LOG="%TEMP%\\pst-setup.log"` to get a log, including each Node.js detection step.
- **Uninstall:** keeps `%USERPROFILE%\\.rpitrack` unless you tick **Remove my settings**. If setup installed Node.js, an unticked **Also uninstall Node.js** box appears; by default Node.js stays.

**Option B: batch files (fallback, no setup.exe):**

1. Download and unzip the app (e.g. into `%USERPROFILE%\\pi-sat-track`)
2. **Double-click `install-win.bat`** and accept the Windows administrator (UAC) prompt
3. If Node.js 22+ is missing, accept the prompt to install **Node.js LTS**
4. The server starts once in a minimized window. The installer prints the URLs:
   `http://localhost` on this PC and `http://<LAN IP>` from a phone or tablet

There is no service and no auto start. Later, start with `start-sat-tracker.bat`.
Re-run `install-win.bat` to update; it stops the running server first and keeps your settings.

| Flag | Effect |
|------|--------|
| `--no-start` | Do not start the server at the end |
| `--skip-node` | Never install Node.js |
| `--no-port80` | No port 80 proxy; use `http://localhost:3000` |

**Administrator is required** for the optional Node install, the port 80 proxy and the firewall rules (see [section 10](#10-port-80-windows)).

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
| **TCP → Hamlib NET rigctl** | An rigctld you run yourself (another PC, or shared with other apps) |
| **Hamlib serial (rigctld)** | Any of Hamlib's ~300 radios over USB-serial — the app starts rigctld for you (see 5.7) |
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

### 5.7 Hamlib (rigctld)

Use **Connection = Hamlib serial (rigctld)** for a radio that has no built-in driver here. Pick the
**Manufacturer**, then the **Model** (the list comes from the installed Hamlib, `rigctl -l`, with each
model's Hamlib status: Stable / Beta / Alpha / Untested). The model you pick always runs through Hamlib
(rigctld). Models we also have a built-in driver for (IC-705, IC-9700, FT-991/991A, FT-847, FT-817/818,
TS-2000, Flex) are marked **built-in driver available** as a hint only; to use our own driver instead,
set **Connection = Native serial** (or TCP for Flex SmartSDR CAT).

Choosing a model fills the serial settings from Hamlib's own defaults (`rigctl --dump-caps`): baud,
data/stop bits, parity, handshake and, for Icom, the CI-V address. Change them under **Serial options**
only if your radio's menu differs. DTR / RTS default to *leave (Unset)*.

Hamlib's capabilities also decide how the radio is driven: radios with satellite mode (SATMODE) use
Main = downlink / Sub = uplink; radios with split use VFO A = downlink / VFO B = uplink; radios without
split track the downlink only.

**What runs:** when Radio is turned on, the app starts `rigctld` bound to `127.0.0.1` on port **4534**
(a second radio on a different serial port gets **4535**; the port is settable). It is restarted
automatically if it exits (1, 2, 5, 10, 30 s back-off) and stopped when Radio is turned off or the profile
changes. rigctld's messages appear in the server log.

**Install / update Hamlib** (Configure → Radio shows the installed version and whether a newer release exists):

| OS | How |
|----|-----|
| Raspberry Pi / Linux | `install-pi.sh` installs `libhamlib-utils` (skip with `SKIP_HAMLIB=1`). **Update** runs `sudo -n apt-get install libhamlib-utils`; if sudo needs a password it shows the command to run in a terminal. Debian/Raspberry Pi OS ship an older Hamlib; a from-source build of the latest release is shown under *Build from source* (run by hand). |
| Windows | **Update** downloads the official `hamlib-w64-<version>.zip` from GitHub, checks its SHA-256, and unpacks it to `%USERPROFILE%\.rpitrack\hamlib\<version>`. **Roll back** returns to the previous one. A Hamlib already installed under `Program Files` is found and used if the app has not downloaded one. |
| macOS | **Update** runs `brew install hamlib` / `brew upgrade hamlib` (needs Homebrew). |

After an update the model list is reloaded. **Reload models** re-reads it by hand.

**Sharing the radio with WSJT-X (or another app):** only one program can open the serial port, so let
Pi Sat Track own it and point the other program at our rigctld. In WSJT-X: *Settings → Radio → Rig =
**Hamlib NET rigctl***, *Network Server = `127.0.0.1:4534`* (4535 for the second radio). WSJT-X must run
on the same computer (rigctld only listens on 127.0.0.1), and Pi Sat Track's Radio must be on so rigctld
is running. Both programs then send commands to the same radio through rigctld.

**Rotators:** Hamlib rotators (`rotctld`) are not wired up yet; use the built-in rotor drivers.

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

Per-satellite UL/DL fine offsets persist per profile under the cache directory (`sat-offsets.json`, keyed profile → satellite; pre-profile global values seed each profile once) so small calibration errors survive restarts.

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

The server always listens on port 3000. `install-win.bat` (through `win-network.ps1`) also sets up:

- **netsh portproxy** `0.0.0.0:80` → `127.0.0.1:3000` (if port 80 is free), with the **IP Helper** service set to Automatic so it survives reboots
- Firewall rule **Pi Sat Track (TCP 80)**: inbound TCP 80, all profiles, local subnet only
- Firewall rule **Pi Sat Track (TCP 3000)**: inbound TCP 3000, all profiles, local subnet only

All profiles are used because home networks are often classified as *Public*; `remoteip=localsubnet` keeps it to your LAN. Rules are deleted and re-added by name, so re-running is safe.

If something else (IIS, Skype, another web server) owns port 80, the installer says so and skips the proxy; use `http://localhost:3000` and `http://<LAN IP>:3000`.

The WSJT-X UDP port (2237) is not opened; WSJT-X normally runs on the same PC.

---

## 11. Uninstall (Windows)

```text
uninstall-win.bat
```

Double-click and accept the UAC prompt, then type `YES`. It stops the Pi Sat Track server (only that one; other Node apps keep running), removes the port 80 proxy, both firewall rules, `node_modules`, the launcher and the app folder. It **asks** before deleting your settings in `%USERPROFILE%\\.rpitrack` (Enter keeps them).

| Flag | Effect |
|------|--------|
| `--data` / `/data` (also `--cache`, `--all`) | Also delete `%USERPROFILE%\\.rpitrack` without asking |
| `--keep-app` | Keep the app folder |
| `--remove-node` | Offer to uninstall Node.js |

Node.js stays installed. Only if the installer installed it does uninstall **offer** to remove it (type `YES`).

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
| [Install — Windows](Install-Windows) | Install, Node, port 80, firewall |
| [Finding your serial port](Serial-Ports) | Device Manager / `dmesg` / plug-unplug |
| [Radio setup](Radio-Setup) | Serial CAT, TCI, dual radio, split |
| [Rotator setup](Rotator-Setup) | RT-21 dual port, GS-232, AZ only, 180° |
| [Connection tests](Connection-Tests) | Radio confirm dialog, rotor guided test |
| [FT-817 notes](FT-817) | FM split, UL lock, limitations |
| [Profiles and offsets](Profiles) | Saving setups, fine tune |
| [Troubleshooting](Troubleshooting) | Expanded FAQ |

---

*Pi Sat Track — alpha documentation. Screenshots and platform-specific pages will be added as the wiki grows.*
