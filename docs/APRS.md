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
  Custom.
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
  frames seen within 3 s, then closes. It never sends anything.
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
  **Send position**, the reason sending is blocked (TX off, Radio off, sat
  below min elevation, mode not APRS, rate limit: 60 s between beacons, 10 s
  between other sends), and recent stations. Windows are draggable,
  minimisable and closable; position and open state are remembered.
- **APRS Heard layer** (map + globe): stations are drawn with their APRS
  symbol (dot when unknown). Position reports plot at their position;
  messages / status without a position plot at the sender's last known
  position, else at a Maidenhead grid in the text (4 or 6 char), else are
  listed only. Your own packets plot at your station. Click a station for its
  recent packets.
- **Messages window**: sent + received messages / status / text in one list,
  digipeated-by-RS0ISS flagged, your own packets heard back marked
  "digipeated". Packets tab: every packet.
- **Log**: every RX/TX packet, one TNC2 line per packet, in
  `~/.rpitrack/aprs/aprs-YYYY-MM-DD.log` (UTC date / time).

Source call = Station callsign (+ optional SSID); position from the Station
grid centre (or exact lat/lon).

## Testing without a TNC

```
node tools/kiss-sim.js --port 6700 --echo --rx-log /tmp/kiss-rx.jsonl
```

Replays sample ISS traffic, prints and logs every frame the tracker sends,
and with `--echo` returns it as digipeated by RS0ISS.

## Credits

- APRS symbol icons: **aprs.fi symbol set** by Heikki Hannikainen, OH7LZB,
  https://github.com/hessu/aprs-symbols, bundled in `images/aprs-symbols/`
  (no CDN). OH7LZB's own designs are licensed
  [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/); other
  symbols' sources and licences are listed in
  `images/aprs-symbols/COPYRIGHT.md` and `ATTRIBUTION.md`.
- Symbol names: https://github.com/hessu/aprs-symbol-index (CC BY-SA 4.0).
- Send model after UISS by Guy Roels, ON6MU (https://qsl.net/on6mu/uiss.htm).
