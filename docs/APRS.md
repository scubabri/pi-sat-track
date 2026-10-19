# APRS / KISS TNC

Pi Sat Track can connect to a KISS TNC, show APRS packets heard via
satellites (ISS, SONATE-2, NO-44, …) on the map / globe, and send packets
through the satellite digipeater the way **UISS** (ON6MU) does. The tracker
keeps tuning the radio (Doppler) as usual; the TNC only does audio + PTT.

## Setup

Configure → **KISS / APRS**:

- **Connect to a KISS TNC**: the client only connects (and reconnects) while
  this is on. Turning it off closes the socket.
- **Software / TNC**: Graywolf (KISS TCP 6700), Direwolf (KISS TCP 8001) or
  Custom. Choosing one fills the port only when the port is empty or still
  another preset's default, so a port you typed (e.g. Graywolf channel 2 on
  8002) is kept.
- **Connection**:
  - **TCP**: **Host** may be this machine (empty = localhost) or a remote
    host, plus **Port**.
  - **Bluetooth**: a Bluetooth Classic (SPP) TNC through the serial port
    device, default `/dev/rfcomm0`, plus baud. Pair the TNC first and bind it
    with rfcomm, e.g. `sudo rfcomm bind 0 <TNC MAC>` (Mobilinkd TNC3/TNC4,
    Kenwood TH-D74/D75, …). BLE is not supported. Profiles saved with the
    old `serial` value load as Bluetooth.
- **Test connection**: opens one TCP connection to the host/port in the form
  (unsaved values, also while disabled), waits up to 5 s, reports any KISS
  frames seen within 3 s, then closes. It never sends anything. If it works
  while Connect is off, it says so: tick **Connect to a KISS TNC** and
  **Save** to stay connected. While KISS is off the APRS window shows
  "KISS off — enable in Configure → KISS / APRS" (click it to open the tab).
- **SSID**: optional. Empty sends the plain station callsign (SSID 0).
- **Map symbol**: pick your icon (Car, House, Satellite dish antenna,
  Campground/tent, Jeep, RV, Weather station, …). Common symbols first, the
  full primary and alternate tables below, searchable by name. Alternate-table
  symbols can carry an overlay character. Stored as the 2-character APRS
  table + code (e.g. `` /` ``), so older profiles keep working.
- **Transmit**: off by default. **Default To** (AX.25 destination, default
  `CQ`), **Default Via** `ARISS`, per-satellite Via overrides (`SAT=PATH`
  lines, e.g. `SONATE-2=DP0SNX`).

### Graywolf

On the Graywolf host: Interfaces → KISS TNC → **+ Add Interface**,
Type **TCP (server)**, listen `0.0.0.0:6700`, Channel = the radio channel used
for satellites, **Mode = Modem** (Graywolf's soft modem keys the radio).
Disable Graywolf beacons and digipeater rules on that channel. Graywolf drops a
repeat of the same packet within 30 s. In Pi Sat Track choose Graywolf, TCP,
and enter that host's IP.

### Direwolf

KISS TCP listens on 8001 by default (`KISSPORT 8001`).

## Operating (UISS model)

Like UISS, every packet uses one header, **To** + **Via**:
`CALL>To,Via:info`, e.g. `K0ABC>CQ,ARISS:…`.

- **To**: the AX.25 destination ("unproto to"), default `CQ` (UISS's example:
  "CQ in the To: field and RS0ISS in the Via: field"). Presets CQ, APRS,
  APRSAT, BEACON, APZPST plus your history.
- **Via**: digipeater path, up to 8 separated by space or comma, default per
  satellite (`ARISS`); empty = direct.
- To / Via are shared between the APRS window and the Messages window and
  remembered (history: To 15, Via 15, For 10, like UISS).

Send types:

| Where | Type | Info field | UISS equivalent |
|---|---|---|---|
| APRS window | **Send position** | `=DDMM.mmN/DDDMM.mmW` + symbol + comment | Send APRS Position (F6) |
| Messages window | **UI text** | sent exactly as typed, e.g. `>JO20AW Hello all` | Send UI Data (F5) |
| Messages window | **APRS message** | `:FOR      :text` (For = addressee, no ack) | Send APRS Message (F7) |
| Messages window | **Header only** | empty | Send UI Header (F4) |

UI text length follows UISS: 80 characters with no or one digipeater, 10 fewer
for each extra digipeater, 255 direct. Text starting with an APRS data type
(`>` status, `=`/`!` position, `:` message …) is decoded as such by APRS
software; anything else shows as plain text.

**Heard stations → To / Via / For** (UISS MHeard list): clicking a callsign
in the Messages window puts it in **For** (message mode, like UISS's
double-click); right-click a callsign in the Messages window or the APRS
window's recent stations, or use the links in a station's map popup, to put
it in **To**, **Via** or **For**.

- **APRS button** (map button stack, directly below Clear Spots; dot = KISS
  state, highlighted while open) toggles the floating **APRS window**: KISS
  status, **APRS Heard** layer toggle, **Messages**, To / Via / Comment and
  **Send position**, the reason sending is blocked (TX off, Radio off, KISS
  not connected, no callsign, rate limit: 60 s between beacons, 10 s between
  other sends), and recent stations. The selected satellite's elevation,
  selection or mode never block sending; with a satellite Via (ARISS, RS0ISS,
  APRSAT, a sat digipeater call) a grey hint notes e.g. "RS-44 is below the
  horizon". WIDEn-N, RELAY, TRACE and other calls are terrestrial paths. Windows are draggable,
  minimisable and closable; position and open state are remembered.
- **APRS Heard layer** (map + globe): stations are drawn with their APRS
  symbol (dot when unknown). Position reports plot at their position;
  messages / status without a position plot at the sender's last known
  position, else at a Maidenhead grid in the text (4 or 6 char), else are
  listed only. Your own packets plot at your station. Click a station for its
  recent packets.
- **Messages window**: all decoded traffic in one list, newest first. Each
  row: time, RX/TX, symbol, call, a type badge and the decoded text
  (position + speed/course, altitude, PHG, cleaned comment and device; status
  text; `→ ADDR: text` for messages; weather values). RS0ISS-digipeated
  packets are flagged and your own packets heard back are marked
  "digipeated". Sent items stay in the list.
  - **Type filters** (all on by default, kept in the browser): Messages (incl.
    acks, UI text and what you sent), Positions (incl. Mic-E / NMEA),
    Status/Beacons (status and plain-text beacons), Objects/Items, Weather,
    Telemetry, Other. Shift-click a chip to show only that type.
  - **Raw** (off by default) adds the raw `CALL>DEST,PATH:info` line under
    each row; hovering a row also shows it.
- **Times** follow the app's UTC | local toggle (same format as the pass
  times): Messages window rows (the zone is shown next to Raw), the APRS
  window's recent stations, station popups and the "Sent" lines.
- **Windows**: drag the title bar to move; drag the left / right / bottom
  edges or the bottom corners to resize (Messages min 340×260, APRS window
  min 230×220). The list fills and scrolls in the new size. Position and size
  are kept in the browser and the window is kept on-screen when the browser
  window gets smaller.
- **Mic-E**: the comment is cleaned like APRS 1.01 / mic-e-types: the leading
  type character (`` ` `` messaging, `'` tracker, Kenwood `>` / `]`), the
  base-91 altitude `xxx}` and the trailing radio code are removed; the radio
  model is shown in the popup / row (e.g. `_1` = Yaesu FTM-300D, `|3` =
  Byonics TinyTrak3, `]=` = Kenwood TM-D710). Packets copied from a log that
  lost the non-printable speed/course byte still decode (speed/course
  unknown).
- Also decoded: PHG (power / height / gain / direction), weather (`_`
  symbol and positionless `_` reports), items (`)`), telemetry (`T#`,
  PARM/UNIT/EQNS/BITS).
- **Log**: every RX/TX packet, one TNC2 line per packet, in
  `~/.rpitrack/aprs/aprs-YYYY-MM-DD.log` (UTC date / time).

Source call = Station callsign (+ optional SSID); position from the Station
grid centre (or exact lat/lon).

## Testing without a TNC

```
node tools/kiss-sim.js --port 6700 --echo --rx-log /tmp/kiss-rx.jsonl
```

Replays sample ISS traffic plus real 144.390 packets (Mic-E, PHG digi,
weather, item, telemetry), prints and logs every frame the tracker sends,
and with `--echo` returns it as digipeated by RS0ISS.

## Credits

- APRS symbol icons: **aprs.fi symbol set** by Heikki Hannikainen, OH7LZB,
  https://github.com/hessu/aprs-symbols, bundled in `images/aprs-symbols/`
  (no CDN). OH7LZB's own designs are licensed
  [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/); other
  symbols' sources and licences are listed in
  `images/aprs-symbols/COPYRIGHT.md` and `ATTRIBUTION.md`.
- Symbol names: https://github.com/hessu/aprs-symbol-index (CC BY-SA 4.0).
- Mic-E device codes: https://github.com/aprsorg/aprs-deviceid
  (`tocalls.yaml`, CC BY-SA 2.0), the continuation of the aprs.org
  mic-e-types list; generated into `lib/aprs/mice-devices.js`.
- Send model after UISS by Guy Roels, ON6MU (https://qsl.net/on6mu/uiss.htm).
