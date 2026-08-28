# EMVCo QR encoding primitives

## Overview

Low level building blocks for the EthSwitch / NBE IPS ET dynamic QR payload, Ethiopia's
national interoperable QR standard. These two functions are pure and have no dependencies.
Their only consumer is `../services/qrEngine.ts`, which assembles the full payload; treat
the three files as one unit when changing anything here.

## Key files

| File | Owns |
|---|---|
| `tlvEncoder.ts` | `formatTlv`, builds one Tag Length Value segment |
| `crc16.ts` | `calculateCrc16CcittFalse`, the trailing checksum |
| `../services/qrEngine.ts` | Assembles the tags in order and appends the checksum |

## Conventions

- Both functions are pure and synchronous. Keep them that way: they are covered by
  `tests/crc16.test.ts` and `tests/qrEngine.test.ts`, which assert exact output strings.
- Tag order in the assembled payload is part of the specification, not a style choice.
  Do not reorder the tags in `qrEngine.ts`.
- Amounts are formatted with `toFixed(2)` before encoding.

## Gotchas

- The CRC is computed over the payload with the literal `6304` already appended (tag 63,
  length 04), and the resulting 4 hex characters are then concatenated. Computing it
  before appending `6304` produces a QR that scanners reject.
- CRC parameters are exact: polynomial `0x1021`, initial value `0xFFFF`, no input or
  output reflection, XOR out `0x0000`. This is CRC-16/CCITT-FALSE, which differs from
  other common CRC-16 variants that share the same polynomial.
- `formatTlv` derives length from `value.length`, which is JavaScript UTF-16 code units,
  not bytes. EMVCo specifies a byte length. Every value used today is ASCII, so the two
  agree, but a non ASCII merchant name or city would produce an invalid length. Encode to
  bytes first if that ever changes.
- Length is padded to 2 digits, so a value longer than 99 characters silently produces a
  malformed segment. `qrEngine.ts` guards this by slicing merchant name to 25 characters
  and city to 15.

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
