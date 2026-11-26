import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { APP_LINK_HOSTS } from './appLinkHosts';

const policy = JSON.parse(readFileSync(new URL('../../../../config/mobile-app-links.json', import.meta.url), 'utf8')) as {
  enabled: boolean;
  domains: string[];
};

describe('universal link hosts', () => {
  it('accepts exactly the hosts the registered app-link policy enables', () => {
    expect([...APP_LINK_HOSTS]).toEqual(policy.enabled ? policy.domains : []);
  });

  it('never accepts a sibling product host', () => {
    for (const host of ['sibling-product.example', 'sibling-saas.example']) expect(APP_LINK_HOSTS).not.toContain(host);
  });
});
