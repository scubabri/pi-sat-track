Pi Sat Track

Browser-based amateur satellite tracker for Raspberry Pi (or any Linux host). Live pass prediction, Doppler-corrected uplink/downlink, modular radio control, and optional rotator pointing — all from a web UI.

Alpha builds are distributed as a zip. There is no git install path; see Installation.

What it does

Tracks LEO amateur satellites from AMSAT frequency data + Celestrak TLEs

Computes Doppler for uplink and downlink (inverting and non-inverting)

Drives one or two radios (TX and RX can be different types)

Optionally drives an AZ/EL rotator (or AZ-only fixed-elevation mounts)

Serves a Leaflet map (NASA Blue Marble), radar view, rotor gauges, pass list, and favorites

Radio and antenna stay off until you enable them in the UI so you can watch geometry without moving hardware.

Architecture

Browser ←→ nginx :80 ←→ Node :3000 (on Pi)
│
├── Radio drivers (serial CAT / TCI / Flex / SDRconnect / rigctl)
└── Rotor drivers (RT-21 dual serial, or GS-232)

Config and profiles live in the browser UI (gear icon) and are pushed to the server over the same WebSocket used for live status.

Radios

Modes

Setup

Behavior

Single radio

One connection for TX/RX. Optional TX radio split (VFO B = uplink) when the radio supports it.

Dual radio

Independent Radio UL (TX) and Radio DL (RX) — any mix of transports.

TX radio split

On a split-capable radio: VFO A = downlink, VFO B = uplink (details vary by driver).

TCP / network backends

Backend

Typical use

AetherSDR TCI

ExpertSDR / AetherSDR WebSocket (default port 50001)

Flex / SmartSDR CAT

TCP CAT to Flex

SDRplay SDRconnect

WebSocket to SDRconnect (GUI + audio on the host)

Hamlib rigctl

TCP to rigctld

Serial CAT backends

Make

Models (supported drivers)

Icom

IC-705, IC-9700, Other (generic CI-V)

Yaesu

FT-991/991A, FT-847, FT-817/818, Other (generic Yaesu CAT)

Kenwood

TS-2000, Other (generic Kenwood CAT)

Serial users must be in the dialout group. Devices are often /dev/ttyACM0 or /dev/ttyUSB0.

FT-817 note

The FT-817 only supports reliable split for FM satellites with a fixed uplink (e.g. SO-50): UL locked on VFO B, Doppler on DL (VFO A). Linear sats on a single 817 use VFO A only (typically DL); full dual Doppler needs two radios (or 817 + SDR).

FM vs linear (general)

FM fixed-UL birds: uplink often held at the published frequency; downlink Doppler-tracked.

Linear birds: both sides Doppler-tracked when the radio path allows (dual VFO or dual radio).

CTCSS encode is applied where the driver and catalog provide a tone (e.g. SO-50 67.0 Hz).

Rotors

Driver

Ports

Notes

Green Heron RT-21

2 serial (AZ + EL)

Optional 180° elevation / N-stop flip logic

GS-232 (K3NG / Fox Delta)

1 serial

AZ+EL on one controller

Optional AZ only for fixed-elevation mounts (no EL commands). Park AZ/EL are set in config. Some setups still use external rotctld; the app can also drive supported rotors via its own serial drivers depending on configuration.

Features (UI)

Satellite catalog + AMSAT status, cached under ~/.rpitrack/

Favorites, multi-mode sats (e.g. ISS), pass prediction (AOS/LOS, max EL, countdown)

Per-sat fine offsets (UL/DL) and optional UL fixed for FM

Profiles (save multiple station/radio setups on the server)

Radio + Antenna enable toggles, lock, CTCSS controls where applicable

Rotor gauges and map footprint / ground track

Requirements

Host

Raspberry Pi OS or similar Debian-based Linux (other Linux may work)

Node.js 22.x (installer can install via NodeSource)

Network path to any remote SDR / TCI / CAT endpoints you use

Optional hardware

One or two CAT-capable radios and/or SDR software (TCI / SDRconnect / Flex / rigctl)

AZ/EL rotator (RT-21 or GS-232-compatible) with appropriate USB-serial adapters

Installation (alpha — zip distribution)

Alpha builds are a zip file. The installer does not clone or pull from any repository.

Copy the zip to the Pi and extract it:

unzip pi-sat-track-\*.zip -d ~/pi-sat-track
cd ~/pi-sat-track

Use the directory that contains package.json, server.js, and install-pi.sh.

Run the installer as a normal user (not root; it will sudo only when needed):

chmod +x install-pi.sh
./install-pi.sh

The script will:

Install system packages (curl, build tools, libudev, nginx if requested)

Install Node.js 22.x LTS if needed

Run npm install in the app directory

Create ~/.rpitrack for caches

Configure nginx :80 → 127.0.0.1:3000 (WebSocket-friendly)

Install and enable a systemd user service sat-tracker

Installer flags

Flag

Effect

--no-nginx

Skip nginx install and site config

--no-service

Skip systemd user service

--update

npm install only + restart service

Updating to a newer alpha zip

systemctl --user stop sat-tracker

# extract the new zip over this tree (or into a fresh folder)

cd ~/pi-sat-track
./install-pi.sh --update

Manual start (no service)

cd ~/pi-sat-track
npm install
node server.js

Server listens on 0.0.0.0:3000.

Service management

systemctl --user status sat-tracker
systemctl --user restart sat-tracker
journalctl --user -u sat-tracker -f

If the service does not start after logout:

sudo loginctl enable-linger $USER

Configuration

All station, radio, and rotor settings are in the browser.

Open http://<pi-ip>/ (nginx) or http://<pi-ip>:3000/

Click the gear (Configuration)

Set callsign, gridsquare, elevation

Configure Radio UL / DL (or single radio): transport, type/protocol or serial make/model/device/baud

Configure rotor type, devices, baud, park, optional 180° EL and AZ-only

Save — endpoints apply live

Profiles can store multiple complete setups on the Pi.

Operation

Select a satellite (favorites or full catalog).

Enable Radio when you want CAT/TCI/SDR frequencies driven.

Enable Antenna when you want the rotator driven.

Use fine-tune / step / center and CTCSS controls as needed for the pass.

Geometry and pass prediction update whether radio/antenna are on or off.

UI overview

Top bar: satellite, modes, radio/antenna toggles, status

Map: footprint, track, station; center control

Radar / gauges: pointing and pass context

Pass list / favorites: upcoming passes and quick select

Config (gear): station, radios, rotor, profiles

Data cache

Under ~/.rpitrack/:

amsat*catalog.json
amsat_status.json
tle*<norad>.txt
sat-offsets.json
profiles (server-side)

Catalog and status refresh periodically. On fetch failure the last good cache is used.

Troubleshooting

UI not reachable on port 80

systemctl status nginx

curl -I http://127.0.0.1:3000/ — Node must be running

Nginx site: /etc/nginx/sites-enabled/sat-tracker

Service not running

systemctl --user status sat-tracker
journalctl --user -u sat-tracker -n 50

Network radio (TCI / Flex / SDRconnect / rigctl) does not connect

Confirm host/port in the config panel for that side

From the Pi: nc -vz <host> <port>

Remote software must listen on a reachable interface; check firewalls

Serial radio does not connect

Correct /dev/tty… and baud (and CI-V address for Icom)

User in dialout; re-login after group change

Only one process should open the port

Rotor does not move

Correct rotor type and device(s) in config

dialout permissions on the USB-serial adapters

For dual-port RT-21, confirm AZ vs EL device order

Wrong location / map not centered

Valid Maidenhead gridsquare + elevation, Save, then center on station

License

Use and modify freely for amateur radio purposes. No warranty.

Credits

Frequencies / status: AMSAT

Catalog source: amateur-satellite-database

TLEs: Celestrak

Propagation: satellite.js

Map: Leaflet

Rotors: Green Heron RT-21, GS-232 / K3NG-style controllers

Network radio examples: ExpertSDR / AetherSDR TCI, Flex SmartSDR, SDRplay SDRconnect, Hamlib
