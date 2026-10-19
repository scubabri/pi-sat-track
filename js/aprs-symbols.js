/**
 * APRS symbols: names + sprite rendering (window.APRS_SYMBOLS).
 *
 * Sprites: hessu/aprs-symbols (aprs.fi set) vendored in images/aprs-symbols/
 * (no CDN; the Pi may be offline): 16 x 6 grid of 24 px cells per table,
 * cell = char code - 33. Table 0 = primary "/", 1 = alternate "\\",
 * 2 = overlay characters (drawn over an alternate symbol when the table
 * char is A-Z / 0-9). See images/aprs-symbols/ATTRIBUTION.md.
 * Names: hessu/aprs-symbol-index (CC BY-SA 4.0), descriptions as used by aprs.fi.
 *
 * Value = 2 chars, table + code, e.g. "/`" (satellite dish), "\\S", "S#" (overlay S on digi).
 */
(function () {
  const NAMES = {"/!": "Police station","/#": "Digipeater","/$": "Telephone","/%": "DX cluster","/&": "HF gateway","/'": "Small aircraft","/(": "Mobile satellite station","/)": "Wheelchair, handicapped","/*": "Snowmobile","/+": "Red Cross","/,": "Boy Scouts","/-": "House","/.": "Red X","//": "Red dot","/0": "Numbered circle: 0","/1": "Numbered circle: 1","/2": "Numbered circle: 2","/3": "Numbered circle: 3","/4": "Numbered circle: 4","/5": "Numbered circle: 5","/6": "Numbered circle: 6","/7": "Numbered circle: 7","/8": "Numbered circle: 8","/9": "Numbered circle: 9","/:": "Fire","/;": "Campground, tent","/<": "Motorcycle","/=": "Railroad engine","/>": "Car","/?": "File server","/@": "Hurricane predicted path","/A": "Aid station","/B": "BBS","/C": "Canoe","/E": "Eyeball","/F": "Farm vehicle, tractor","/G": "Grid square, 3 by 3","/H": "Hotel","/I": "TCP/IP network station","/K": "School","/L": "PC user","/M": "Mac apple","/N": "NTS station","/O": "Balloon","/P": "Police car","/R": "Recreational vehicle","/S": "Space Shuttle","/T": "SSTV","/U": "Bus","/V": "ATV, Amateur Television","/W": "Weather service site","/X": "Helicopter","/Y": "Sailboat","/Z": "Windows flag","/[": "Human","/\\": "DF triangle","/]": "Mailbox, post office","/^": "Large aircraft","/_": "Weather station","/`": "Satellite dish antenna","/a": "Ambulance","/b": "Bicycle","/c": "Incident command post","/d": "Fire station","/e": "Horse, equestrian","/f": "Fire truck","/g": "Glider","/h": "Hospital","/i": "IOTA, islands on the air","/j": "Jeep","/k": "Truck","/l": "Laptop","/m": "Mic-E repeater","/n": "Node, black bulls-eye","/o": "Emergency operations center","/p": "Dog","/q": "Grid square, 2 by 2","/r": "Repeater tower","/s": "Ship, power boat","/t": "Truck stop","/u": "Semi-trailer truck, 18-wheeler","/v": "Van","/w": "Water station","/x": "X / Unix","/y": "House, yagi antenna","/z": "Shelter","\\!": "Emergency","\\#": "Digipeater, green star","\\$": "Bank or ATM","\\&": "Gateway station","\\'": "Crash / incident site","\\(": "Cloudy","\\)": "Firenet MEO, MODIS Earth Observation","\\*": "Snow","\\+": "Church","\\,": "Girl Scouts","\\-": "House, HF antenna","\\.": "Ambiguous, question mark inside circle","\\/": "Waypoint destination","\\0": "Circle, IRLP / Echolink/WIRES","\\8": "802.11 WiFi or other network node","\\9": "Gas station","\\:": "Hail","\\;": "Park, picnic area","\\<": "Advisory, single red flag","\\>": "Red car","\\?": "Info kiosk","\\@": "Hurricane, Tropical storm","\\A": "White box","\\B": "Blowing snow","\\C": "Coast Guard","\\D": "Drizzling rain","\\E": "Smoke, Chimney","\\F": "Freezing rain","\\G": "Snow shower","\\H": "Haze","\\I": "Rain shower","\\J": "Lightning","\\K": "Kenwood HT","\\L": "Lighthouse","\\N": "Navigation buoy","\\O": "Rocket","\\P": "Parking","\\Q": "Earthquake","\\R": "Restaurant","\\S": "Satellite","\\T": "Thunderstorm","\\U": "Sunny","\\V": "VORTAC, Navigational aid","\\W": "NWS site","\\X": "Pharmacy","\\[": "Wall Cloud","\\^": "Aircraft","\\_": "Weather site","\\`": "Rain","\\a": "Red diamond","\\b": "Blowing dust, sand","\\c": "CD triangle, RACES, CERTS, SATERN","\\d": "DX spot","\\e": "Sleet","\\f": "Funnel cloud","\\g": "Gale, two red flags","\\h": "Store","\\i": "Black box, point of interest","\\j": "Work zone, excavating machine","\\k": "SUV, ATV","\\m": "Value sign, 3 digit display","\\n": "Red triangle","\\o": "Small circle","\\p": "Partly cloudy","\\r": "Restrooms","\\s": "Ship, boat","\\t": "Tornado","\\u": "Truck","\\v": "Van","\\w": "Flooding","\\y": "Skywarn","\\z": "Shelter","\\{": "Fog"};
  const COMMON = ["/-", "/`", "/>", "/(", "\\S", "/;", "/j", "/R", "/_", "/[", "/y", "/l", "/k", "/v", "/<", "/b", "/Y", "/s", "/'", "/O", "/#", "/r", "//", "\\k"];
  const BASE = "images/aprs-symbols/aprs-symbols-24-";
  function parse(sym) {
    const s = String(sym || "");
    if (s.length !== 2) return null;
    const t = s[0];
    const c = s.charCodeAt(1);
    if (c < 33 || c > 126) return null;
    if (t === "/") return { table: 0, code: s[1], overlay: "" };
    if (t === "\\") return { table: 1, code: s[1], overlay: "" };
    if (/^[A-Z0-9]$/.test(t)) return { table: 1, code: s[1], overlay: t };
    return null;
  }
  function name(sym) {
    const p = parse(sym);
    if (!p) return "";
    const n = NAMES[(p.table ? "\\" : "/") + p.code] || "Symbol " + sym;
    return p.overlay ? n + " (overlay " + p.overlay + ")" : n;
  }
  function cell(table, ch, size) {
    const i = ch.charCodeAt(0) - 33;
    const z = size || 24;
    const x = (i % 16) * z;
    const y = Math.floor(i / 16) * z;
    return (
      "background-image:url(" + BASE + table + ".png);background-image:image-set(url(" + BASE + table + ".png) 1x,url(" + BASE + table + "@2x.png) 2x);" +
      "background-size:" + 16 * z + "px " + 6 * z + "px;background-position:-" + x + "px -" + y + "px;"
    );
  }
  /** HTML for a symbol icon (span); "" when the value is not a valid symbol. */
  function html(sym, size, cls) {
    const p = parse(sym);
    if (!p) return "";
    const z = size || 24;
    const box = "display:inline-block;position:relative;width:" + z + "px;height:" + z + "px;vertical-align:middle;";
    const t = name(sym).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
    let inner = "";
    if (p.overlay) inner = '<span style="position:absolute;left:0;top:0;width:' + z + "px;height:" + z + "px;" + cell(2, p.overlay, z) + '"></span>';
    return '<span class="aprs-sym ' + (cls || "") + '" title="' + t + '" style="' + box + cell(p.table, p.code, z) + '">' + inner + "</span>";
  }
  /** All named symbols of a table ("/" or "\\"), in code order. */
  function list(table) {
    const out = [];
    for (let c = 33; c <= 126; c++) {
      const k = table + String.fromCharCode(c);
      if (NAMES[k]) out.push({ sym: k, name: NAMES[k] });
    }
    return out;
  }
  window.APRS_SYMBOLS = { NAMES, COMMON, parse, name, html, list };
})();
