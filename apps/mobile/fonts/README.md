# The app's typefaces: sources, licences and checks

UX-UG-NATIVE-ARCHIVO-AND-PUBLIC-SANS-TYPEFACES-20261115 (#8928).

The theme (promo package `README-AI.md` rule 8, `kit/brand/theme/tokens.json`
and `ug-theme.css`) sets Archivo 800 for headings and the app name and Public
Sans for text and controls. The package and `public/assets/` carry these faces
only as `.woff2` web subsets, with no licence file. React Native needs static
TrueType or OpenType files, one per weight on Android, so the files here were
taken unmodified from each typeface's own upstream repository on Sun Nov 15,
2026, about 9:17 PM ET.

They live in `apps/mobile/fonts/`, not `assets/`, which holds only inspected
PNG and SVG image inputs (`scripts/verify-icon.mjs`).
They are listed under the `expo-font` plugin in `apps/mobile/app.config.ts`
and embedded in the build; nothing is loaded from a font host at run time.
iOS registers each file and reads its family name ("Archivo", "Public Sans");
Android groups the same files into XML font families under those two names, so
a style's `fontFamily` and `fontWeight` pick the same real face on both.
Android before API 28 picks only a normal or a bold face from a family, so
Android also gets "Public Sans Medium" and "Public Sans SemiBold", one face
each, and `resolveTypography` in `src/theme/tokens.ts` names them there. An
embedded font reaches phones only in a store build, never in an over-the-air
update. The roles that use them are `typography` in
`apps/mobile/src/theme/tokens.ts`; `src/theme/typography.test.ts` checks the
files, the plugin list and the roles against each other and the theme.

## Archivo

- File: `Archivo-ExtraBold.ttf` (weight 800), 191,700 bytes.
  sha256: 9fff67922ae2bc376a9e5c6d644eebf8c5b17f62a0f38e5f016e4b7e3903662f
- Source: https://github.com/Omnibus-Type/Archivo, path
  `fonts/ttf/Archivo-ExtraBold.ttf` at commit
  211127690e8ff106c36c935f7e5e697114cff103 (master, Sep 2, 2026); the file
  last changed in commit b5d63988ce19d044d3e10362de730af00526b672 (Feb 1, 2021).
  Font version 2.001.
- Licence: `OFL-Archivo.txt`, the repository's `OFL.txt` at the same commit,
  unchanged (SIL Open Font License 1.1, Copyright 2020 The Archivo Project
  Authors).
  sha256: 108b4e57c9c796d3d38d0428ca7ee39de47ad93187302718d9b2d8864b9b716b

## Public Sans

- Files, each at release v2.001 (tag commit
  c7923167a592d941646f99fb7b5fba17aa7d69e1, May 11, 2022), path
  `fonts/ttf/`, font version 2.001:
  - `PublicSans-Regular.ttf` (weight 400), 84,836 bytes.
    sha256: b577e9bc9887284e90aae5ad0699689ce36b5cd96207efbec68f77f8aed88379
  - `PublicSans-Medium.ttf` (weight 500), 84,576 bytes.
    sha256: ca804b5c7569a59f1507c5d3e1aa389c354bf2ae6b864bc537fa7672d28469d6
  - `PublicSans-SemiBold.ttf` (weight 600), 84,412 bytes.
    sha256: 9f537d607dc78450841dc31c401e3c4ba7a0ba7217e8b34c1be684a983806399
  - `PublicSans-Bold.ttf` (weight 700), 84,744 bytes.
    sha256: bddd96a0bcd49b292524b4beff57d770ce97482fb3f84b788959422e06b863a6
- Source: https://github.com/uswds/public-sans
- Licence: `OFL-PublicSans.txt`, the repository's `OFL.txt` at the same
  commit, unchanged (SIL Open Font License 1.1, Copyright 2015 The Public Sans
  Project Authors).
  sha256: 157a9e77f7580246e97c769490e2e977ae94399f9d30f4556015c41fe8c28bac
- `LICENSE-PublicSans.md`, the repository's `LICENSE.md` at the same commit,
  unchanged: Public Sans is a modified Libre Franklin; the GSA modifications are
  CC0 and the combined font is used under the SIL Open Font License 1.1.
  sha256: 82f0d3cad45f264192db156360b4a710fe7060885f6aa261e6539f13cb9eb0d9

## What was checked

- Each file is a static TrueType font (sfnt version 1.0, `glyf` outlines, no
  `fvar` variation table), its embedding permission (OS/2 fsType) is 0, its
  PostScript name equals its file name, and its OS/2 weight class is the
  weight above (fontTools 4.60.1, run outside this repository).
- Each file covers Latin, every accented letter and punctuation mark in the
  app's English and Spanish strings (á é í ó ú ñ Á Í Ó Ú ¿ « » ’ “ ” – — … •
  · ° × § ›), and also É Ñ ü ¡ and the euro sign. Not covered, and drawn by the system
  font on both platforms when they appear: the arrows and ✓-style symbols, the
  midline ellipsis of the message "⋯ Actions" control, and the narrow no-break
  space that date formatting can return.
- Size: the five files add 530,268 bytes (about 518 KiB) before store
  compression.

## Not embedded

Spline Sans Mono, the theme's face for numbers, codes and small capital
labels, is not in this record. Adding it later takes its static files from
https://github.com/SorkinType/SplineSansMono (`fonts/ttf/`, about 75 KB per
weight) with its `OFL.txt`, one more list entry under the `expo-font` plugin
(a gate path, mobile release configuration), a `data` role in the tokens, and
a store build.
