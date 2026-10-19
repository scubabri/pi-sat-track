# APRS / KISS TNC

Pi Sat Track can connect to a KISS TNC, show APRS packets heard via
satellites (ISS, SONATE-2, NO-44, …) on the map / globe, and send packets
through the satellite digipeater the way **UISS** (ON6MU) does. The tracker
keeps tuning the radio (Doppler) as usual; the TNC only does audio + PTT.

## Setup

Configure → **KISS / APRS**:

- **Connect to a KISS TNC**: master switch. Nothing connects (and nothing
  reconnects) while it is off; turning it off closes every connection.
- **KISS connections**: a list, one row per TNC channel / port. Graywolf
  binds one radio channel per KISS TCP port, so a Graywolf PC with a FlexRadio plus Direwolf for 9600 is three
  rows:

  | Name | Software | Host:port | Role | Speed |
  | --- | --- | --- | --- | --- |
  | FLEX ch1 | Graywolf | pc:8001 | RX + TX | 1200 AFSK |
  | VHF Dax 3 | Graywolf | pc:8002 | RX only | 1200 AFSK (144.390) |
  | Direwolf 9600 | Direwolf | pc:8003 | RX + TX | 9600 G3RUH |

  Each row: **Enabled**, **Name** (shown on packets, in Raw view and popups),
  **Software** (Graywolf / Direwolf / Custom: fills the port only when it is
  empty or still another preset's default, never over a port you typed),
  **Connection** TCP (**Host**, empty = localhost, + **Port**) or Bluetooth
  (serial **Device**, default `/dev/rfcomm0`, + **Baud**; pair the TNC and
  `sudo rfcomm bind 0 <TNC MAC>`; Mobilinkd TNC3/TNC4, TH-D74/D75; BLE not
  supported), **Role** (RX only / TX only / RX + TX), **Speed** (1200 AFSK /
  9600 G3RUH = the modem on that channel), **Advanced → KISS port**
  (Direwolf / multi-port TNCs only; leave 0 for Graywolf), a live status
  (connected · RX n · TX n, or the error and retry time), **Test** and **×**
  (remove). **+ Add connection** adds a row (up to 8). Older profiles with a
  single endpoint load it as row 1 (RX + TX, 1200; host, port, KISS port and
  connection kept).
- **RX**: every enabled RX or RX + TX connection feeds the same packet list,
  map and log; each packet is tagged with its connection name. The same
  packet (identical TNC2 line, path included) heard on a second connection
  within 5 s is shown once with both names (`[FLEX ch1 + VHF Dax 3]`);
  digipeated copies with a different path stay separate. A TX-only
  connection's receive side is ignored.
- **TX routing**: with a satellite selected and a satellite Via, the send
  goes out on an enabled TX-capable connection whose **speed matches the
  satellite** (the Default TX connection first if it matches, else a
  connected one). With no satellite, or a terrestrial Via (WIDEn-N, direct),
  it goes out on the **Default TX connection** (Auto = the first TX-capable
  1200 connection). If nothing matches, sending is blocked with the reason,
  e.g. "No 9600 TX connection configured for CroCube". The APRS window and
  the Messages window show the connection next to Send ("TX via FLEX ch1
  1200 · ISS 1200 (AMSAT digipeater list)").
- **Satellite speed**: Transmit → **Per-satellite speed** (`SAT=1200` /
  `SAT=9600` lines, key = sat name, catalog key or NORAD) wins; else the
  AMSAT digipeater list (lib/aprs/sat-speeds.js: ISS, IO-86, NO-44,
  SONATE-2 = 1200; CroCube, GRBBeta, KNACKSAT-2, KOSTKA, LASARsat, Marina =
  9600); else the selected mode text (`9k6` / `9600` / `G3RUH` = 9600,
  `1k2` / `AFSK` = 1200); else 1200. (The selected mode never blocks
  sending; for satellites on that list a mode named just `9k6_GFSK` does not
  even show the "not an APRS mode" hint.)
- **Test** (per row): opens one TCP connection to that row's host/port
  (unsaved values, also while disabled), waits up to 5 s, reports any KISS
  frames seen within 3 s, then closes. It never sends anything. If it works
  while the master switch (or the row) is off, it says so: tick **Connect to
  a KISS TNC** (or the row's **Enabled**) and **Save** to stay connected.
  While KISS is off the APRS window shows "KISS off — enable in Configure →
  KISS / APRS" (click it to open the tab).
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

Graywolf binds **one channel per KISS TCP port**. On the Graywolf host:
Interfaces → KISS TNC → **+ Add Interface**, Type **TCP (server)**, listen
e.g. `0.0.0.0:8001`, Channel = the radio channel, **Mode = Modem**
(Graywolf's soft modem keys the radio). Add one interface (port) per channel
you want, e.g. 8001 = FLEX ch1 (TX), 8002 = VHF Dax 3 (RX only, 144.390),
and one Pi Sat Track connection row per port. Disable Graywolf beacons and
digipeater rules on the satellite channel. Graywolf drops a repeat of the
same packet within 30 s. Graywolf only has 1200 AFSK / PSK modems: for 9600
G3RUH satellites run Direwolf next to it.

### Direwolf (9600 G3RUH)

Direwolf's KISS TCP default is 8001, which clashes with a Graywolf port 8001,
so give it its own port. Minimal `direwolf.conf` for a 9600 channel on a
FlexRadio DAX pair (Windows; use the device numbers or names `direwolf -x`
lists):

```
ADEVICE  4 5            # DAX RX / DAX TX audio devices
ACHANNELS 1
CHANNEL 0
MYCALL   N0CALL
MODEM    9600           # G3RUH; needs flat audio (DAX is)
PTT      VOX            # or CAT / RTS for your radio
KISSPORT 8003
```

Then add a row: Software Direwolf, host = that PC, port 8003, Role RX + TX,
Speed **9600 G3RUH**. KISS port (Advanced) stays 0 unless that Direwolf
serves several channels on one KISS TCP port.

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

## Digipeat confirmation and the digipeat log

Every packet you send is tracked (source incl. SSID, destination, info). When
a packet with the **same source and same info** (path ignored) is heard on
any KISS connection and its path has at least one **used** hop (H bit, shown
`*`), the TX is marked:

- **Digipeated by SHEPRD, KF6RAL-1** (all distinct digipeaters heard), or
- **Heard via RS0ISS** for a satellite digipeater,
- **No digipeat heard** (amber) if nothing came back within
  *Configure → KISS / APRS → Digipeat wait* (default 30 s). A later echo
  (up to 10 min) still upgrades it.

An echo whose path has no used hop (e.g. your own packet heard direct from a
second receiver) is not a digipeat. Echoes never create a station in Recent
Stations or on the map; in the Messages window they are listed under the TX
row (click the green ✓ badge). The small APRS window shows the state of the
last send right under *Send position*, live, in UTC or local time per the
time toggle: amber `Sent 17:05:45 MT — waiting for digipeat…`, then green
`✓ Digipeated by KU5R-6 · 17:05:54 MT` (all digipeaters if several; `✓ Heard
via RS0ISS` for a satellite) or `Sent … — no digipeat heard (30 s)`, plus
**Digipeats: N** (click to open the log).

Each digipeated echo is appended to `~/.rpitrack/aprs/digipeats.jsonl` (one
JSON object per line, kept across restarts): UTC `time`, `src`, `dst`, `path`
as sent, `digis` (H-bit calls), `viaSat`, `sat` name / `satEl` /
`satAboveHorizon`, `conn` (connection heard on), `txConn`, `lat`/`lon`,
`info` and the `raw` echo. The Messages window **Digipeats** button lists it
newest first (satellite digipeats highlighted, times follow the UTC/local
toggle) and **Export CSV** downloads it (`/api/aprs/digipeats.csv`).

## Third-party packets

Packets with data type `}` (APRS 1.01 ch. 17, traffic gated from APRS-IS to
RF by an iGate) are decoded recursively: the encapsulated
`SRC>DEST,PATH:info` is parsed and classified by its own type. For

```
KU5R-6>APMI06,WIDE2-1:}OTA>APZ100,TCPIP,KU5R-6*::K7ETC-7 :DE K6BOY-5 QSL Thx for the chase! 73{6278
```

the row reads `OTA → K7ETC-7: DE K6BOY-5 QSL Thx for the chase! 73 (via
iGate KU5R-6)` (a message, id 6278). The station is the inner source (OTA),
not the iGate, and it is plotted only if the inner packet carries a
position. The same inner packet gated by several iGates (and with a
different inner destination, e.g. APZ100 vs APRS) is one ×N group; expanding
it lists each iGate, inner header, path and connection. Message addressees
shorter than the standard 9-character field (as some gateways send) are
accepted.

## Duplicate copies

A packet is often heard several times: direct, via one or more digipeaters
and on more than one connection. Copies with the same source and info within
*Duplicate window* (default 30 s, like Graywolf's dedupe) are one row with
the first-heard time and a **×N** badge; click it to see each copy's time,
path (`direct` or `via SHEPRD*,WIDE2*`) and connection (with Raw on, the raw
line of each). Filter counts count rows, and the map / Recent Stations update
once per group. Identical frames (same path too) heard on two connections
within 5 s are merged before this, into one copy tagged with both names.

## Testing without a TNC

```
node tools/kiss-sim.js --port 6700 --echo --rx-log /tmp/kiss-rx.jsonl
node tools/kiss-sim.js --port 8001,8002,8003 --echo   # several channels / TNCs
```

With several ports, samples go round-robin to one port each and every 4th
goes to all ports (to exercise de-duplication; `--all` sends every sample
everywhere). Frames sent by the tracker are logged with the TCP port they
arrived on and echoed back on that port only.

Replays sample ISS traffic plus real 144.390 packets (Mic-E, PHG digi,
weather, item, telemetry), prints and logs every frame the tracker sends,
and with `--echo` returns it as digipeated by RS0ISS. `--echo-digi
SHEPRD,KF6RAL-1` instead returns one copy per listed terrestrial digipeater;
`--dupes` re-sends each sample direct and via SHEPRD* shortly after (×N rows).

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
- Satellite digipeater speeds: AMSAT "Digipeater Satellites"
  (https://www.amsat.org/live-digipeater-satellites/, updated 2026-10-18),
  cross-checked with SatNOGS DB.
- Send model after UISS by Guy Roels, ON6MU (https://qsl.net/on6mu/uiss.htm).
