import { unionCatalogCatalogue } from "../../lib/i18n/unionCatalog.js";
import { lookup } from "../../lib/i18n/runtime.js";

// The network shares the public union namespace and its EN/ES register.
export const unionNetworkCopy = (language) => (key) => lookup(unionCatalogCatalogue, language, `unions.network.${key}`);
