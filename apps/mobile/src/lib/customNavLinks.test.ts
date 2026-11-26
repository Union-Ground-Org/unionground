import { describe, expect, it } from 'vitest';

import { customLinkHost, customNavLinks, isAllowedCustomLinkUrl } from './customNavLinks';

const config = (values: Record<string, string>) => ({ switches: values });

describe('custom navigation links (native)', () => {
  it('accepts only https addresses without credentials', () => {
    expect(isAllowedCustomLinkUrl('https://example.org/library')).toBe(true);
    for (const bad of ['javascript:alert(1)', 'http://example.org', 'data:text/html,x', 'https://user:pw@example.org', 'example.org', '', null]) {
      expect(isAllowedCustomLinkUrl(bad)).toBe(false);
    }
  });

  it('renders a slot only with a label and an allowed address', () => {
    expect(customNavLinks(config({
      'text.navigation.custom_link_1_label': 'Library',
      'text.navigation.custom_link_1_url': 'https://example.org/library',
      'text.navigation.custom_link_2_label': 'Bad',
      'text.navigation.custom_link_2_url': 'javascript:alert(1)',
    }))).toEqual([{ key: 'custom-link-1', label: 'Library', url: 'https://example.org/library' }]);
    expect(customNavLinks(config({ 'text.navigation.custom_link_1_url': 'https://example.org' }))).toEqual([]);
    expect(customNavLinks(null)).toEqual([]);
  });

  it('names the host the link opens', () => {
    expect(customLinkHost('https://benefits.example.org:8443/x')).toBe('benefits.example.org:8443');
    expect(customLinkHost('not a url')).toBe('');
  });
});
