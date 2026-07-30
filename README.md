# Pi Sat Track (Node Web UI)

Browser-based linear amateur satellite tracker for Raspberry Pi. Provides live pass prediction, Doppler-corrected frequencies over TCI to AetherSDR, and azimuth/elevation control of a Green Heron RT-21 rotator via dual `rotctld` instances.

The UI is a Leaflet map (Blue Marble base) with radar view, rotor gauges, pass profile, and a station configuration panel (callsign, gridsquare, elevation, TCI/rotctld endpoints).

## Features

- **Satellite catalog** from AMSAT frequency data + status, with local cache under `~/.rpitrack/`
- **TLE-based propagation** via `satellite.js`
- **Live Doppler** uplink/downlink (inverting and non-inverting modes)
- **Manual uplink fine-tune** (step size +/−)
- **Radio (TCI)** and **Antenna (rotctld)** toggles — both start off
- **Elevation floor** and park behaviour for the rotator
- **Pass prediction**: AOS / LOS, max elevation, duration, countdown
- **Station config** in the browser: callsign, Maidenhead gridsquare, elevation (m), TCI host/port, rotctld host + AZ/EL ports
- **WebSocket** live updates to all connected clients

## Hardware / software stack

| Component | Role |
|-----------|------|
| Raspberry Pi (or any Linux host) | Runs Node server + optional nginx + `rotctld` |
| Green Heron RT-21 AZ/EL | USB serial rotor controller |
| Flex Radio + AetherSDR (Mac or other) | TCI WebSocket (default port 50001) |
| Hamlib | `rotctld` for RT-21 (model 405) |

Typical layout:

```
Browser  ←→  nginx :80  ←→  Node :3000  (on Pi)
                              │
                              ├── TCI WebSocket → AetherSDR (Mac)
                              ├── rotctld :4535 → AZ
                              └── rotctld :4536 → EL
```

## Requirements

### On the Pi

- Raspberry Pi OS (or similar Debian-based)
- Network access to the machine running AetherSDR
- Two `rotctld` instances for the RT-21 (or equivalent), listening on the ports you configure

Example `rotctld` launch (adjust serial devices and baud):

```bash
rotctld -m 405 -r /dev/ttyUSB1 -s 4800 -T 0.0.0.0 -t 4535   # azimuth
rotctld -m 405 -r /dev/ttyUSB0 -s 4800 -T 0.0.0.0 -t 4536   # elevation
```

Confirm:

```bash
echo "p" | nc 127.0.0.1 4535
echo "p" | nc 127.0.0.1 4536
```

User must be in the `dialout` group for serial access.

### AetherSDR / TCI

- TCI enabled
- Listening on all interfaces (`*.50001`), not only localhost
- Firewall allows inbound TCP 50001 from the Pi

## Installation

Clone the repository and run the installer from the app directory (or repo root — the script detects both):

```bash
git clone https://github.com/scubabri/pi-sat-track.git
cd pi-sat-track/node/sat-tracker

chmod +x install-pi.sh
./install-pi.sh
```

The script will:

1. Install system packages (curl, git, build tools, nginx if requested)
2. Install Node.js 22.x LTS (NodeSource) if needed
3. Run `npm install` in the app directory
4. Create `~/.rpitrack` for caches
5. Configure nginx as a reverse proxy from port 80 → `127.0.0.1:3000` (WebSocket headers included)
6. Install and enable a systemd **user** service `sat-tracker`

Run as a normal user (not root). The script uses `sudo` only where needed for apt/nginx.

### Installer flags

| Flag | Effect |
|------|--------|
| `--no-nginx` | Skip nginx install and site config |
| `--no-service` | Skip systemd user service |
| `--update` | Re-run `npm install` only |
| `--upgrade` | `git pull` + `npm install` + restart service |

Day-to-day updates after the first install:

```bash
cd /path/to/pi-sat-track/node/sat-tracker
./install-pi.sh --upgrade
```

### Manual start (no service)

```bash
cd node/sat-tracker
npm install
node server.js
# or: npm start
```

Server listens on `0.0.0.0:3000`.

### Service management

```bash
systemctl --user status sat-tracker
systemctl --user restart sat-tracker
journalctl --user -u sat-tracker -f
```

If the service does not start after logout, enable lingering:

```bash
sudo loginctl enable-linger $USER
```

## Configuration

All station and endpoint settings are done in the browser.

1. Open the UI: `http://<pi-ip>/` (nginx) or `http://<pi-ip>:3000/`
2. Click the gear icon (Configuration)
3. Set:

| Field | Purpose |
|-------|---------|
| Callsign | Display only |
| Gridsquare | Maidenhead; converted to lat/lon for the observer |
| Elevation (m) | Station height above sea level |
| TCI host / port | AetherSDR machine (default `127.0.0.1:50001`) |
| rotctld host | Host running both AZ and EL daemons (default `127.0.0.1`) |
| AZ port / EL port | Default `4535` / `4536` |

4. **Save** — endpoints are applied live; map can be recentered with **Center Map**.

Environment variables can still set defaults before the UI overrides them:

| Variable | Default |
|----------|---------|
| `TCI_HOST` | `127.0.0.1` |
| `TCI_PORT` | `50001` |
| `ROTOR_AZ_HOST` | `127.0.0.1` |
| `ROTOR_AZ_PORT` | `4535` |
| `ROTOR_EL_HOST` | same as AZ host |
| `ROTOR_EL_PORT` | `4536` |
| `ROTOR_MIN_EL` | `10` |
| `ROTOR_PARK_EL` | `0` |
| `ROTOR_MOVE_INTERVAL_MS` | `1000` |

## Operation

1. Open the UI in a browser.
2. Select a satellite from the dropdown (or browse the full catalog via **Browse full catalog...**).
3. Configure station location and endpoints if not already done.
4. Enable **Radio** when you want Doppler commands sent to AetherSDR.
5. Enable **Antenna** when you want the rotator driven.
6. Use the fine-tune +/− buttons and step size (Hz) for uplink offset; double-click the step field to reset.
7. **Center** (via fine-tune controls / config) clears uplink fine offset.

Geometry, pass prediction, and the map update continuously whether radio/antenna are on or off.

### UI overview

- **Top bar**: satellite selector, pass countdown / AOS–LOS–max–duration, Radio / Antenna buttons, config gear
- **Map**: Blue Marble + ground track trail, observer marker
- **Radar**: polar az/el view of the satellite
- **Rotor gauges**: current AZ and EL reported by `rotctld`
- **Pass profile**: elevation vs time for the current/next pass
- **Sidebar**: mode select, uplink/downlink frequencies + Doppler, passband limits, toggles, station and satellite status

## Cache

Network data is cached under `~/.rpitrack/`:

```
~/.rpitrack/
  amsat_catalog.json
  amsat_status.json
  tle_<norad>.txt
  tle_<norad>.meta.json
  ...
```

Catalog and status refresh periodically (default every 6 hours). On fetch failure the last good cache is used.

## Troubleshooting

**UI not reachable on port 80**

- `systemctl status nginx`
- `curl -I http://127.0.0.1:3000/` — Node must be running
- Check nginx site: `/etc/nginx/sites-enabled/sat-tracker`

**Service not running**

```bash
systemctl --user status sat-tracker
journalctl --user -u sat-tracker -n 50
```

**Radio does not connect**

- Confirm TCI host/port in the config panel
- From the Pi: `nc -vz <tci-host> 50001`
- AetherSDR must listen on all interfaces; allow the port through the Mac firewall

**Rotor does not move**

- Confirm both `rotctld` processes and the host/ports in the config panel
- `echo "p" | nc <rotor-host> 4535`
- Check serial device order and permissions (`dialout` group)

**Wrong location / map not centered**

- Set a valid Maidenhead gridsquare and elevation, then **Save** and **Center Map**

## License

Use and modify freely for amateur radio purposes. No warranty.

## Credits

- Frequencies / status: [AMSAT](https://www.amsat.org/)
- Catalog source: [amateur-satellite-database](https://github.com/palewire/amateur-satellite-database)
- TLEs: [Celestrak](https://celestrak.org/)
- Propagation: [satellite.js](https://github.com/shashwatak/satellite-js)
- Map: [Leaflet](https://leafletjs.com/)
- Rotor protocol: Hamlib / Green Heron RT-21
- Radio control: ExpertSDR / AetherSDR TCI
