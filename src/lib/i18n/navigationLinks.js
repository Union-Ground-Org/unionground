import { navigationLinksCatalogueSpanish } from "./locales/es/namespaces/navigationLinks.js";
// Web navigation copy: staff desk labels and admin-set custom links
// (REQ-UG-CUSTOM-NAV-LINKS-20261001), including the admin copy for the four
// `text.navigation.custom_link_*` settings. Split out of the src/lib/i18n.js
// barrel like requestInvite.js; this file is the ONLY declaration of these keys.
export const navigationLinksCatalogue = {
  en: {
    "staffnav.qaPreview": "Q&A desk preview",
    "shell.groupLinks": "Links",
    "nav.customLinkOpens": "{label} (opens in a new tab)",
    "settings.def.text.navigation.custom_link_1_label.label": "Custom link 1: label",
    "settings.def.text.navigation.custom_link_1_label.description": "Shown in the web and phone menus when both the label and the address are set. Up to 40 characters.",
    "settings.def.text.navigation.custom_link_1_url.label": "Custom link 1: address",
    "settings.def.text.navigation.custom_link_1_url.description": "The https:// address the link opens. Other kinds of address, including http: and javascript:, are refused.",
    "settings.def.text.navigation.custom_link_2_label.label": "Custom link 2: label",
    "settings.def.text.navigation.custom_link_2_label.description": "Shown in the web and phone menus when both the label and the address are set. Up to 40 characters.",
    "settings.def.text.navigation.custom_link_2_url.label": "Custom link 2: address",
    "settings.def.text.navigation.custom_link_2_url.description": "The https:// address the link opens. Other kinds of address, including http: and javascript:, are refused.",
  },
  get es() { return navigationLinksCatalogueSpanish; },
};
