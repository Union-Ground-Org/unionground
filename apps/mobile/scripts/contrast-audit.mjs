import { readFile } from 'node:fs/promises';

const paletteUrl = new URL('../src/theme/palette.json', import.meta.url);
const palette = JSON.parse(await readFile(paletteUrl, 'utf8'));

const pairs = [
  ['background', 'foreground', 4.5, 'Page text'],
  ['card', 'cardForeground', 4.5, 'Card text'],
  ['popover', 'popoverForeground', 4.5, 'Floating surface text'],
  ['primary', 'primaryForeground', 4.5, 'Primary actions'],
  ['secondary', 'secondaryForeground', 4.5, 'Secondary actions'],
  ['muted', 'mutedForeground', 4.5, 'Quiet supporting content'],
  ['accent', 'accentForeground', 4.5, 'Highlights'],
  ['destructive', 'destructiveForeground', 4.5, 'Destructive actions'],
  ['input', 'foreground', 4.5, 'Form values'],
  ['compass', 'compassForeground', 4.5, 'Compass actions'],
  ['border', 'background', 3, 'Meaningful outlines'],
  ['ring', 'background', 3, 'Focus indicator'],
  ['muted', 'primary', 3, 'Chapter rail tile outline against rail'],
  ['card', 'primary', 3, 'Chapter rail avatar outline against panel'],
  // Status ramp (visual-language brief §C). Each hue ships as a 6px dot on the
  // tinted-neutral status-pill body, which is `muted`, so it is audited as a
  // non-text element against that fill.
  ['muted', 'statusActive', 3, 'Status ramp — active/in progress'],
  ['muted', 'statusAttention', 3, 'Status ramp — needs attention'],
  ['muted', 'statusQueued', 3, 'Status ramp — queued/new'],
  ['muted', 'statusDone', 3, 'Status ramp — done/closed'],
  // Attention's second channel: the 1px ring around its 8px dot. It is audited
  // against the pill body it sits on, and against the dot it encircles — a
  // ring that matches either surface is not a channel.
  ['muted', 'statusAttentionRing', 3, 'Status ramp — attention dot ring on the pill body'],
  ['statusAttention', 'statusAttentionRing', 1.5, 'Status ramp — attention ring against its own dot'],
  // Regression tripwire, not an accessibility floor: WCAG says nothing about
  // two states of the same component, and neither state is text. The dark
  // scheme once ran active and attention through the gold family at 1.43:1
  // which is one hue at two lightnesses. 1.7
  // is set just under the shipped dark pair's 1.76 so any edit that walks the
  // two hues back together fails here first — raising it is a palette
  // decision, not a fix for this row.
  ['statusActive', 'statusAttention', 1.7, 'Status ramp — active vs attention separation (regression tripwire, dark ships at 1.76)'],
  // Chart series (chartPalette.ts): bars, lines, rings and areas sit on the
  // card and, full-bleed, on the page. The validator's separation, lightness
  // and chroma checks run in src/theme/chartPalette.test.ts.
  ['card', 'chartSeries1', 3, 'Chart series 1 on card'],
  ['card', 'chartSeries2', 3, 'Chart series 2 on card'],
  ['card', 'chartSeries3', 3, 'Chart series 3 on card'],
  ['background', 'chartSeries1', 3, 'Chart series 1 on page'],
  ['background', 'chartSeries2', 3, 'Chart series 2 on page'],
  ['background', 'chartSeries3', 3, 'Chart series 3 on page'],
  // The theme's six series and its "other" colour (promo package tokens.json
  // `series`, `seriesOther`). The theme gives the dark form only three series,
  // so these rows measure the palettes that carry them and skip the dark form.
  ['card', 'chartSeries4', 3, 'Chart series 4 on card', 'optional'],
  ['card', 'chartSeries5', 3, 'Chart series 5 on card', 'optional'],
  ['card', 'chartSeries6', 3, 'Chart series 6 on card', 'optional'],
  ['card', 'chartSeriesOther', 3, 'Chart other bucket on card', 'optional'],
  ['background', 'chartSeries4', 3, 'Chart series 4 on page', 'optional'],
  ['background', 'chartSeries5', 3, 'Chart series 5 on page', 'optional'],
  ['background', 'chartSeries6', 3, 'Chart series 6 on page', 'optional'],
  ['background', 'chartSeriesOther', 3, 'Chart other bucket on page', 'optional'],
  // Quiet ink (theme ink-3): placeholders in fields on the input fill, a
  // card, the page and the tinted search pill. Never on `muted`, where it
  // measures 4.12:1.
  ['input', 'quietForeground', 4.5, 'Placeholder in a field'],
  ['card', 'quietForeground', 4.5, 'Placeholder or quiet caption on a card'],
  ['background', 'quietForeground', 4.5, 'Placeholder or quiet caption on the page'],
  ['secondary', 'quietForeground', 4.5, 'Placeholder in a tinted search pill'],
];

function luminance(hex) {
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(hex.slice(offset + 1, offset + 3), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function ratio(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

let failed = false;
console.log('Mode\tPair\tBackground\tForeground\tRatio\tAA\tAAA\tUsage');
for (const [mode, tokens] of Object.entries(palette)) {
  for (const [backgroundName, foregroundName, minimum, usage, presence] of pairs) {
    const background = tokens[backgroundName];
    const foreground = tokens[foregroundName];
    if (presence === 'optional' && foreground === undefined) continue;
    if (background === undefined || foreground === undefined) {
      console.log(`${mode}\t${backgroundName}/${foregroundName}\tmissing token\tFAIL\t${usage}`);
      failed = true;
      continue;
    }
    const value = ratio(background, foreground);
    const passes = value >= minimum;
    failed ||= !passes;
    console.log(
      `${mode}\t${backgroundName}/${foregroundName}\t${background}\t${foreground}\t${value.toFixed(2)}:1\t${passes ? 'PASS' : 'FAIL'}\t${value >= 7 ? 'PASS' : '—'}\t${usage}`,
    );
  }
}

if (failed) process.exitCode = 1;
