// The build's brand. plugins/babel-brand-name.js replaces the identifier
// below with the resolved brand at build time (its name, whether this is an
// official Union Ground LLC build, the official service's hosts and, in an
// official build only, the official mark). Without that plugin (unit tests)
// the app is an unbranded development build.
import { parsePhoneBrand } from './brandPolicy';

declare const __UNIONGROUND_PHONE_BRAND__: unknown;

const injected = typeof __UNIONGROUND_PHONE_BRAND__ === 'undefined' ? undefined : __UNIONGROUND_PHONE_BRAND__;

export const phoneBrand = parsePhoneBrand(injected);

export { ATTRIBUTION_NOTICE, OFFICIAL_SERVICE_LABEL, operatorPageUrl, showsOfficialServiceMark } from './brandPolicy';
