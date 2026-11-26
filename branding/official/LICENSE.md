# Official Union Ground branding

The files in this folder are the Union Ground mark and app icon. They are
trademarks of Union Ground LLC.

**They are not licensed under the GNU Affero General Public License.** The AGPL
that covers the rest of this repository does not apply to them, and the
license grants no rights in them (see the section 7 term in [`NOTICE`](../../NOTICE)).
Modified versions of Union Ground may not use them. Read
[`TRADEMARKS.md`](../../TRADEMARKS.md) for what you may and may not do with
the Union Ground name and logo.

Only Union Ground LLC's own builds use this folder: a web build with
`VITE_OFFICIAL_BRANDING=1` or a phone build with `OFFICIAL_BRANDING=1`. Every
other build is unbranded: it takes its name from `VITE_BRAND_NAME` (phone:
`BRAND_NAME`), draws a plain rounded square with the name's initial, and uses
the neutral placeholder icons under `public/` and `apps/mobile/assets/`. If you
run your own copy, leave official branding off and use your own name and logo.
Deleting this folder is fine: an official build then refuses to start.

This follows the model of Mozilla's `browser/branding/official`.

## Files

Copied byte for byte from the Union Ground brand kit (`kit/brand/logo/`):

| File | What it is | Used for |
|---|---|---|
| `mark-tile.svg` | The mark on its tile | Web mark and favicon |
| `mark-on-dark.svg` | The mark without its tile, for green and dark surfaces | Web mark on dark surfaces |
| `mark-tile-32.png` | The tile, 32 px | Web favicon |
| `mark-tile-180.png` | The tile, 180 px | Apple touch icon |
| `mark-tile-192.png` | The tile, 192 px | Web app manifest icon |
| `mark-tile-512.png` | The tile, 512 px | Web app manifest icon |
| `mark-tile-1024.png` | The tile, 1024 px | Phone app icon and splash |
