# APRS / KISS TNC

Pi Sat Track can connect to a KISS TNC, show APRS packets heard via
satellites (ISS, SONATE-2, NO-44, …) on the map / globe, and send your
position or a short message through the satellite digipeater. The tracker
keeps tuning the radio (Doppler) as usual; the TNC only does audio + PTT.

## Setup

Configure → **KISS / APRS**:

- **Connect to a KISS TNC**: the client only connects (and reconnects) while
  this is on. Turning it off closes the socket.
- **Software / TNC**: Graywolf (KISS TCP 6700), Direwolf (KISS TCP 8001) or
  Custom. **Host** may be this machine (empty = localhost) or a remote host.
- **Connection**: Network (KISS over TCP) or Serial: Bluetooth Classic TNCs
  bound with `sudo rfcomm bind 0 <MAC>` (`/dev/rfcomm0`: Mobilinkd TNC3/TNC4
  classic, Kenwood TH-D74/D75) and USB serial TNCs. BLE is not supported yet.
- **Test connection**: opens one TCP connection to the host/port in the form
  (unsaved values, also while disabled), waits up to 5 s, reports any KISS
  frames seen within 3 s, then closes. It never sends anything.
- **SSID**: optional. Empty sends the plain station callsign (SSID 0).
- **Transmit**: off by default. Default Via `ARISS`, per-satellite Via
  overrides (`SAT=PATH` lines, e.g. `SONATE-2=DP0SNX`).

### Graywolf

On the Graywolf host: Interfaces → KISS TNC → **+ Add Interface**,
Type **TCP (server)**, listen `0.0.0.0:6700`, Channel = the radio channel used
for satellites, **Mode = Modem** (Graywolf's soft modem keys the radio).
Disable Graywolf beacons and digipeater rules on that channel. Graywolf drops a
repeat of the same packet within 30 s. In Pi Sat Track choose Graywolf and
enter that host's IP.

### Direwolf

KISS TCP listens on 8001 by default (`KISSPORT 8001`).

## Operating

- **Map APRS box** (below WSJT Heard / Clear Spots): KISS status, the
  **APRS Heard** layer toggle, **Messages** (floating window) and the main
  action **Send position** (Via + comment editable). When sending is blocked
  the reason is shown (TX off, Radio off, sat below min elevation, mode not
  APRS, rate limit: 60 s between beacons, 10 s between messages).
- **APRS Heard layer** (map + globe): position reports plot at their
  position. Messages / status without a position plot at the sender's last
  known position, else at a Maidenhead grid in the text (4 or 6 char), else
  are listed only. Your own packets plot at your station. Click a station
  for its recent packets.
- **Messages window**: sent + received messages / status in one list,
  digipeated-by-RS0ISS flagged, your own packets heard back marked
  "digipeated". To / Via / Text at the bottom (To empty = status packet). No
  acks or retries. Packets tab: every packet.
- **Log**: every RX/TX packet, one TNC2 line per packet, in
  `~/.rpitrack/aprs/aprs-YYYY-MM-DD.log` (UTC date / time).

Source call = Station callsign (+ optional SSID), destination `APZPST`
(experimental tocall), position from the Station grid centre (or exact
lat/lon), symbol `/``.

## Testing without a TNC

```
node tools/kiss-sim.js --port 6700 --echo --rx-log /tmp/kiss-rx.jsonl
```

Replays sample ISS traffic, prints and logs every frame the tracker sends,
and with `--echo` returns it as digipeated by RS0ISS.
