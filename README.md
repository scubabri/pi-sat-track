# Pi Sat Track

Raspberry Pi–based linear amateur satellite tracker with Doppler correction for AetherSDR (Flex Radio via TCI) and azimuth/elevation control for a Green Heron RT-21 rotator.

Runs on the Pi, talks to AetherSDR on a Mac over the LAN, and drives dual `rotctld` instances for AZ/EL.

## Features

- **Linear satellites:** RS-44, AO-07 (Mode B), FO-29, JO-97
- **Live frequencies** from [AMSAT Live Linear Satellites](https://www.amsat.org/live-linear-satellites/), with local cache fallback
- **TLE updates** from Celestrak, cached per NORAD ID under `~/.rpitrack/`
- **Doppler correction** over TCI WebSocket to AetherSDR (inverting and non-inverting)
- **Manual downlink tune** mirrored to uplink (1:1 Hz, inverted for linear transponders)
- **Uplink fine tune** via keyboard (typed step size + `+` / `-`)
- **Rotor control** via Hamlib `rotctld` (model 405 – Green Heron RT-21)
- **Elevation floor** at 10°: park at calculated AOS azimuth when below horizon
- **Pass prediction:** AOS/LOS at 10°, max elevation, countdown (UTC + local)
- **curses UI** with colour cues for pass urgency and passband edges

## Hardware / software stack

| Component | Role |
|-----------|------|
| Raspberry Pi 5 (or similar) | Runs tracker + `rotctld` |
| Green Heron RT-21 AZ/EL | USB serial rotor controller |
| Flex Radio + AetherSDR (Mac) | TCI on TCP port 50001 |
| Hamlib | `rotctld` / `rotctl` for RT-21 |

Typical layout:

```
Mac (AetherSDR TCI :50001)
        ▲
        │ WebSocket
        │
Pi ── tracker (pi_sat_track.py)
        │
        ├── rotctld :4535  → AZ  (/dev/ttyUSBx)
        └── rotctld :4536  → EL  (/dev/ttyUSBy)
```

## Requirements

### System packages (Pi)

```bash
sudo apt update
sudo apt install -y python3 python3-pip hamlib-utils
```

### Python packages

```bash
sudo pip3 install --break-system-packages skyfield websockets
```

Or with a venv if you prefer:

```bash
python3 -m venv ~/sat-tracker
source ~/sat-tracker/bin/activate
pip install skyfield websockets
```

### Runtime services on the Pi

- Two `rotctld` instances for the RT-21 (AZ and EL), e.g. via `rt21_rotctld.py` / systemd
- Serial devices with correct permissions (user in `dialout` group)

Example rotctld launch (adjust devices):

```bash
rotctld -m 405 -r /dev/ttyUSB1 -s 4800 -T 0.0.0.0 -t 4535   # azimuth
rotctld -m 405 -r /dev/ttyUSB0 -s 4800 -T 0.0.0.0 -t 4536   # elevation
```

Confirm:

```bash
echo "p" | nc 127.0.0.1 4535
echo "p" | nc 127.0.0.1 4536
```

### Mac

- AetherSDR running with TCI enabled
- Listening on all interfaces (`*.50001`), not only localhost
- macOS firewall allowing inbound TCP 50001 from the Pi

## Installation

```bash
# Copy script into place
sudo cp pi_sat_track.py /usr/local/bin/
sudo chmod +x /usr/local/bin/pi_sat_track.py

# Cache directory is created automatically on first run
# ~/.rpitrack/
```

## Configuration

Edit the network block near the top of `pi_sat_track.py`:

```python
# Mac running AetherSDR (TCI)
MAC_IP = "172.17.18.50"          # your Mac's LAN IP
TCI_URI = f"ws://{MAC_IP}:50001"

# Rotor on this Pi
PI_IP = "127.0.0.1"
AZ_PORT, EL_PORT = 4535, 4536
```

Also set your station location:

```python
LAT, LON, ELEV_M = 40.5, -111.9, 1324   # degrees, degrees, metres
```

Optional constants:

| Constant | Default | Meaning |
|----------|---------|---------|
| `MIN_EL` | `10.0` | AOS/LOS and park elevation (degrees) |
| `ROTOR_UPDATE_INTERVAL` | `30.0` | Seconds between rotor commands |
| `EDGE_MARGIN` | `5e3` | Hz near passband edge → yellow |

## Usage

```bash
pi_sat_track.py RS-44
pi_sat_track.py AO-07
pi_sat_track.py FO-29
pi_sat_track.py JO-97
```

Satellite argument is required (no default).

### Keyboard controls

| Key | Action |
|-----|--------|
| **R** | Connect / disconnect radio (TCI to AetherSDR) |
| **A** | Enable / disable antenna (rotctld) |
| **0–9** | Type UL fine-step size in Hz |
| **+** / **-** | Apply ±step to uplink (step persists until you type a new number) |
| **Backspace** | Edit step digits |
| **C** | Centre – clear DL offset and UL fine tune |
| **q** | Quit |

Starts with **radio and antenna off**. Geometry and pass prediction always run. Press **R** and **A** when you are ready to drive the radio and rotors.

### UI colour cues

**Pass status**

| Colour | Meaning |
|--------|---------|
| Green | More than 30 minutes to AOS |
| Yellow | 5–30 minutes to AOS (or just after LOS) |
| Red | Under 5 minutes to AOS, or currently in pass |

**Frequencies**

| Colour | Meaning |
|--------|---------|
| Green | Inside passband, clear of edges |
| Yellow | Within 5 kHz of passband edge |
| Red | Outside published passband |

## Cache

All network data is cached under `~/.rpitrack/`:

```
~/.rpitrack/
  amsat_freqs.json       # AMSAT linear frequencies + timestamp
  tle_44909.txt          # TLE lines
  tle_44909.meta.json    # fetch time
  tle_7530.txt
  ...
```

- On startup the tracker tries a live fetch (AMSAT + Celestrak).
- On failure it uses the cache and shows age (e.g. `TLE cache age 3h`).
- If there is no cache either, built-in AMSAT defaults are used for frequencies.

## Supported satellites (defaults)

Frequencies follow the AMSAT live linear table (centres derived from published ranges):

| CLI name | NORAD | Uplink | Downlink | Notes |
|----------|-------|--------|----------|-------|
| RS-44 | 44909 | 145.935–145.995 LSB | 435.610–435.670 USB | V/u inverting |
| AO-07 | 7530 | 432.125–432.175 LSB | 145.925–145.975 USB | Mode B U/v inverting |
| FO-29 | 24278 | 145.900–146.000 LSB | 435.800–435.900 USB | V/u inverting |
| JO-97 | 43803 | 435.100–435.120 LSB | 145.855–145.875 USB | JY1SAT U/v inverting |

## Rotor behaviour

- Commands are **absolute** az/el every 30 seconds (not relative steps).
- While satellite elevation is 10° or higher: track az/el.
- While elevation is below 10°: hold elevation at 10° and azimuth at the next calculated **AOS azimuth** (10° rising).

## TCI / VFO mapping

Assumes AetherSDR slices:

- **RX0** – downlink
- **RX1** – uplink

Commands are of the form `vfo:0,0,<hz>;` and `vfo:1,0,<hz>;`.

## Troubleshooting

**No `amsat_freqs.json`**

- Confirm Pi can reach AMSAT:
  `curl -sL -A "sat_tracker/1.0" https://www.amsat.org/live-linear-satellites/ | head`
- Parser expects numeric entities such as `&#8211;` to be decoded (included in current script).

**Wrong satellite orbit / TLE name**

- Celestrak responses are cached **per NORAD** as `tle_<norad>.txt` so they do not collide on a shared `gp.php` cache name.

**Radio does not connect**

- Check Mac IP and that AetherSDR shows `*.50001` listening.
- From the Pi: `nc -vz <mac-ip> 50001`
- Allow port 50001 through the Mac firewall if needed.

**Rotor does not move**

- `rt21_rotctld.py status` or `ss -tlnp | grep -E '4535|4536'`
- Test: `echo "p" | nc 127.0.0.1 4535`

**Serial device order (AZ vs EL)**

- Swap `/dev/ttyUSB0` and `/dev/ttyUSB1` in the rotctld start script if axes are reversed.

## Future work

A Node.js port with a browser UI is planned:

- `satellite.js` for TLEs
- Node `ws` client for TCI
- `net` sockets for rotctld
- Web UI on port 3000, optionally behind nginx on port 80

The Python curses tracker remains the reference implementation until that lands.

## License

Use and modify freely for amateur radio purposes. No warranty.

## Credits

- Frequencies: [AMSAT Live Linear Satellites](https://www.amsat.org/live-linear-satellites/)
- TLEs: [Celestrak](https://celestrak.org/)
- Rotor protocol: Hamlib / Green Heron RT-21
- Radio control: ExpertSDR / AetherSDR TCI
