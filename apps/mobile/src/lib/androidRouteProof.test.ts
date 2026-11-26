import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const driver = readFileSync(
  fileURLToPath(new URL('../../scripts/android-route-proof.mjs', import.meta.url)),
  'utf8',
);

describe('Android physical route proof contract', () => {
  it('uses the current PREVIEW accessibility label and enters preview explicitly from signed out', () => {
    expect(driver).toContain('PREVIEW demo, switch role, ');
    expect(driver).not.toContain('SAMPLE demo, switch role, ');
    expect(driver).not.toContain('switch hat');
    expect(driver).toContain("process.env.ANDROID_ROUTE_PROOF_REUSE_ACTIVITY !== '1'");
    expect(driver).toContain("await route('startup-preview-account', 'unionground://account', 'Account')");
    expect(driver).toContain("await tapDescriptionAfterScroll('Exit preview', 'startup-exit-preview')");
    expect(driver).toContain("await tapDescriptionAfterScroll('Confirm exit preview', 'startup-confirm-exit-preview')");
    expect(driver).not.toContain("await tapDescription('Exit preview', 'startup-exit-preview')");
    expect(driver).toMatch(/await assertCurrent\('startup-signed-out', \['Sign in', 'Try the demo'\], \{/);
    expect(driver).toContain("await tapDescription('Try the demo', 'startup-preview-entry')");
    expect(driver).not.toContain("if (!description && searchable(xml).includes('Try the demo'))");
    expect(driver).toContain('The installed app did not reach the explicit PREVIEW surface.');
  });

  it('asserts the organizing-tool denial copy that the native authorization gate renders', () => {
    const hats = 'Organizer, Committee, Campaign lead, Advisor, Admin, and Campaign chair hats open it.';
    expect(driver).toContain(`['Campaign agreements is an organizing tool', '${hats}']`);
    expect(driver).toContain(`['Organization analytics is an organizing tool', '${hats}']`);
    expect(driver).toContain(`['Power map is an organizing tool', '${hats}']`);
    expect(driver).toContain("['Committee desk opens under another hat', 'The Committee hat opens it.']");
    expect(driver).not.toMatch(/is a staff tool|Steward|President|Coordinator/);
  });

  it('walks every organizing hat in the dock order and returns to Worker', () => {
    const order = ['Worker', 'Organizer', 'Committee', 'Campaign lead', 'Advisor', 'Admin', 'Campaign chair', 'Worker'];
    const switches = [...driver.matchAll(/await switchHat\('([^']+)', '([^']+)', '[^']+'\)/g)].map((match) => [match[1], match[2]]);
    expect(switches).toEqual(order.slice(0, -1).map((hat, index) => [hat, order[index + 1]]));
    expect(driver).toContain("const slug = nextLabel.toLowerCase().replace(/\\s+/g, '-');");
  });

  it('proves Union Ground destinations and leaves out the ones it does not ship', () => {
    for (const route of ['unionground://campaign', 'unionground://compass', "unionground://issue/b872b7c3-fdf2-497e-9d91-5b456724a1f0', ['HCU-104'"]) {
      expect(driver).toContain(route);
    }
    expect(driver).toContain("['about', 'About Union Ground'], ['ai-disclosure', 'Guide disclosure']");
    expect(driver).not.toMatch(/unionground:\/\/(union|case\/|feature\/dues)|Compass/);
  });

  it('asserts the backed collective-action screen heading rather than its catalog label', () => {
    expect(driver).toContain("['actions', 'Digital Picket Line']");
    expect(driver).not.toContain("['actions', 'Collective actions']");
  });

  it('keeps leadership health separate from the all-hat campaign catalog', () => {
    expect(driver).toContain("'unionground://feature/chapter-health', ['Health portfolio', 'Score over time']");
    expect(driver).toContain("'unionground://feature/chapters', ['Campaigns', 'North County Transit Workers']");
  });
});
