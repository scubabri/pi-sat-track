# APRS symbol sprites

Files `aprs-symbols-24-{0,1,2}.png` and `@2x` variants are copied unmodified
from **hessu/aprs-symbols** (the aprs.fi symbol set) by Heikki Hannikainen,
OH7LZB: https://github.com/hessu/aprs-symbols (commit f2286a9, 2024-10-10).

- `-0` primary table `/`, `-1` alternate table `\`, `-2` overlay characters.
- 16 x 6 grid of 24 px cells (48 px in `@2x`), cell index = ASCII code - 33.

Licence: per the upstream `COPYRIGHT.md` (copied here), the symbols drawn by
OH7LZB are **CC BY-SA 2.0** (https://creativecommons.org/licenses/by-sa/2.0/).
Other symbols in the set come from public-domain / CC sources listed in
`COPYRIGHT.md`, some are vectorised versions of the traditional APRS symbol set
(original designers G4IDE / KH4G / WA8LMF, licence status unknown) and a few are
brand logos (Apple, Microsoft, Kenwood) owned by those companies.

Symbol names in `js/aprs-symbols.js` come from **hessu/aprs-symbol-index**
(https://github.com/hessu/aprs-symbol-index, commit 68a2734), CC BY-SA 4.0.
