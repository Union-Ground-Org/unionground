// The product name the server functions print in mail, notifications, the
// Guide's messages and other text a person reads. It is the same name the web
// build was made with (VITE_BRAND_NAME and VITE_OFFICIAL_BRANDING are set on
// the deployment for both): Union Ground only in Union Ground LLC's official
// deployment, the operator's own name everywhere else. The build already
// refused a missing or borrowed name, so the server never fails here; a
// deployment it cannot read falls back to the development name.
import {
  DEVELOPMENT_BRAND_NAME,
  applyBrandName,
  brandInitial,
  resolveBrand,
} from "../../src/lib/shared-core/brand.js";

export function serverBrand(env = process.env) {
  try {
    return resolveBrand({
      brandName: env?.VITE_BRAND_NAME,
      officialBranding: env?.VITE_OFFICIAL_BRANDING,
      // The build checked branding/official/; the deployed functions do not
      // carry it.
      officialAssetsPresent: true,
      production: false,
    });
  } catch {
    return Object.freeze({ name: DEVELOPMENT_BRAND_NAME, official: false, initial: brandInitial(DEVELOPMENT_BRAND_NAME) });
  }
}

export function serverBrandName(env = process.env) {
  return serverBrand(env).name;
}

// Copy written with "Union Ground" in the source, in this deployment's name:
// a string, or every string inside an array or plain object. The attribution
// notice and "Union Ground LLC" stay as written.
export function brandText(value, env = process.env) {
  const name = serverBrandName(env);
  const visit = (item) => {
    if (typeof item === "string") return applyBrandName(item, name);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
    }
    return item;
  };
  return visit(value);
}
