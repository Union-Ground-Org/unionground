# SEC-UG-CATALOG-PRIVACY-FILTER-LOOK-ALIKE-LETTERS-AND-TWICE-ENCODED-URLS-20261115 (#8766).
# Builds scripts/union-catalog/look-alike-letters.mjs from the Unicode confusables data, version
# 18.0.0: https://www.unicode.org/Public/18.0.0/security/confusables.txt, downloaded by hand (the
# filter never fetches it). The file must be that version exactly: its digest is checked below.
# Usage:
#   python3 -I scripts/union-catalog/build-look-alike-letters.py <confusables.txt> > scripts/union-catalog/look-alike-letters.mjs
# Letter categories and names come from this Python's unicodedata; its Unicode version is written
# into the table's header, and a letter it does not know yet is left out of the table.
import hashlib
import re
import sys
import unicodedata

SOURCE_SHA256 = "6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92"
BASIC = re.compile(r"[A-Za-z]")
SMALL_CAPITAL = re.compile(r"LATIN LETTER SMALL CAPITAL ([A-Z])")

src = sys.argv[1]
data = open(src, "rb").read()
if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
    sys.exit("build-look-alike-letters: the source is not confusables.txt version 18.0.0")


def is_mark(ch):
    return unicodedata.category(ch).startswith("M")


raw = {}
for line in data.decode("utf-8-sig").splitlines():
    body = line.split("#", 1)[0].strip()
    if not body:
        continue
    a, b = [x.strip() for x in body.split(";")[:2]]
    sa = [chr(int(h, 16)) for h in a.split()]
    sb = [chr(int(h, 16)) for h in b.split()]
    # A letter whose reading is one basic Latin letter, alone or followed only by marks
    # (Greek eta reads as "n" with a mark below).
    if len(sa) != 1 or not unicodedata.category(sa[0]).startswith("L") or BASIC.fullmatch(sa[0]):
        continue
    if not BASIC.fullmatch(sb[0]) or not all(is_mark(ch) for ch in sb[1:]):
        continue
    raw[sa[0]] = sb[0]


def base(ch):
    return "".join(c for c in unicodedata.normalize("NFKD", ch) if not is_mark(c))


table = {}
for s, t in raw.items():
    b = base(s)
    if BASIC.fullmatch(b):
        continue  # NFKD already reads it as that letter
    if len(b) == 1 and b != s and b in raw:
        continue  # NFKD reaches another row of the table
    table[s] = t
# Every Latin small capital reads as its small letter; the data reads only some of them so.
for code in range(0x110000):
    ch = chr(code)
    match = SMALL_CAPITAL.fullmatch(unicodedata.name(ch, ""))
    if match:
        table[ch] = match.group(1).lower()
# Reviewed additions the data does not make (it reads kappa as kra and has no row for chi):
# Greek small kappa and chi look like k and x in a name.
for s, t in (("κ", "k"), ("χ", "x")):
    table.setdefault(s, t)
# Cherokee small letters are the capitals' own shapes, smaller; the data lists only the capitals.
for s, t in list(table.items()):
    if unicodedata.name(s, "").startswith("CHEROKEE LETTER "):
        small = s.lower()
        if small != s and small not in table and unicodedata.name(small, "").startswith("CHEROKEE SMALL LETTER "):
            table[small] = t.lower()


def esc(ch):
    o = ord(ch)
    return f"\\u{o:04X}" if o <= 0xFFFF else f"\\u{{{o:X}}}"


def script(ch):
    n = unicodedata.name(ch, "?").split()
    return n[0] if n[0] not in ("MATHEMATICAL", "DOUBLE-STRUCK") else "MATHEMATICAL"


groups = {}
for s in sorted(table, key=ord):
    groups.setdefault(script(s), []).append(s)
out = [
    "// Generated from the Unicode confusables data, UTS #39 confusables.txt version 18.0.0",
    "// (https://www.unicode.org/Public/18.0.0/security/confusables.txt, sha256:" + SOURCE_SHA256 + "),",
    "// with letter categories and names from Unicode " + unicodedata.unidata_version + " (Python's unicodedata). Unicode data:",
    "// copyright Unicode, Inc., under the terms at https://www.unicode.org/terms_of_use.html.",
    "// Rebuild, never edit by hand: python3 -I scripts/union-catalog/build-look-alike-letters.py",
    "// <confusables.txt> > scripts/union-catalog/look-alike-letters.mjs.",
    "// Rows: every letter the data reads as one basic Latin letter, alone or followed only by marks,",
    "// less the letters NFKD already reads as a basic Latin letter or as another row; every Latin",
    "// small capital, as its small letter; Greek small kappa as k and chi as x (reviewed additions);",
    "// and the Cherokee small letters, which take their capital's letter. A row read as \"l\" is also",
    "// read as \"I\" by foldLookAlikes.",
    "// SEC-UG-CATALOG-PRIVACY-FILTER-LOOK-ALIKE-LETTERS-AND-TWICE-ENCODED-URLS-20261115 (#8766).",
    "// Detection only (foldLookAlikes in privacy-filter.mjs): never an exported value, a key or a hash.",
    "export const LOOK_ALIKE_LETTERS = new Map(Object.entries({",
]
for g in sorted(groups):
    out.append(f"  // {g.title()}")
    line = "  "
    for s in groups[g]:
        item = f'"{esc(s)}": "{table[s]}", '
        if len(line) + len(item) > 118:
            out.append(line.rstrip())
            line = "  "
        line += item
    out.append(line.rstrip())
out.append("}));")
print("\n".join(out))
print(len(table), file=sys.stderr)
