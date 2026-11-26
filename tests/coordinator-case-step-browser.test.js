// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { BROWSER_HOOK_TIMEOUT } from './helpers/browser-hook-timeout.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectVisualMeasurements, classifyVisualMeasurements } from '../scripts/visual-audit.mjs';

let browser;
const root = process.cwd();
const css = (await Promise.all(['sg-tokens.css', 'styles.css', 'coordinator-theme.css']
  .map(path => readFile(resolve(root, 'src', path), 'utf8')))).join('\n');
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await browser?.close(); });

for (const theme of ['light']) {
  it.each([390, 768, 1440])(`keeps populated coordinator steps separate from deadlines in ${theme} at %i px`, async width => {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : width === 768 ? 1024 : 900 }, colorScheme: theme });
    try {
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === 'http://127.0.0.1:56810' && /^\/assets\/.*\.woff2$/.test(url.pathname)) {
          return route.fulfill({ path: resolve(root, 'public', url.pathname.slice(1)), contentType: 'font/woff2' });
        }
        return route.abort();
      });
      const workspaceTheme = 'union-ground';
      // CaseButton's public row structure; Investigation is authored by the SAMPLE parity seed.
      await page.setContent(`<base href="http://127.0.0.1:56810/"><main class="sg-app" data-workspace-theme="${workspaceTheme}" style="width:${width >= 1024 ? width - 520 : width}px"><div class="gq-screen" data-casework-theme="casefile-control"><section class="gq-cases">${['Investigation', 'Step 1', 'Review'].map((step, index) => `<article class="gq-row"><button type="button" class="gq-row__btn" aria-expanded="false"><span class="gq-c-av gq-av" aria-hidden="true">JP</span><span class="gq-c-main"><span class="gq-name">Fictional member ${index + 1}</span><span class="gq-issue">Overtime review · <span class="gq-ref">UNIONDEMO-PG-000${index + 1}</span></span></span><span class="gq-c-meta"><span class="gq-c-step"><span class="gq-step">${step}</span></span><span class="gq-c-due gq-due">Aug 15</span><span class="gq-c-status"><span class="gq-status">Active</span></span></span></button></article>`).join('')}</section></div></main>`);
      await page.addStyleTag({ content: css });
      await page.evaluate(() => document.fonts.ready);
      for (const state of ['default', 'hover', 'focus', 'expanded']) {
        const row = page.locator('.gq-row__btn').first();
        if (state === 'hover') await row.hover();
        if (state === 'focus') await row.focus();
        if (state === 'expanded') await row.evaluate(node => node.setAttribute('aria-expanded', 'true'));
        const geometry = await page.locator('.gq-row__btn').evaluateAll(rows => rows.map(row => {
          const rect = selector => { const r = row.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
          return { badge: rect('.gq-step'), cell: rect('.gq-c-step'), due: rect('.gq-c-due') };
        }));
        for (const { badge, cell, due } of geometry) {
          expect(badge.right, `${state}: step badge must fit its cell`).toBeLessThanOrEqual(cell.right + 0.5);
          expect(due.left - badge.right, `${state}: readable gap before deadline`).toBeGreaterThanOrEqual(9.5);
        }
        const audit = classifyVisualMeasurements(await page.evaluate(collectVisualMeasurements));
        expect(audit.failures.filter(finding => finding.rule === 'element-collision')).toEqual([]);
      }
    } finally { await page.close(); }
  });
}
