// The name the shell and member card show for the member's current
// organization. Copy never hard-codes a specific organization: the strings
// carry an {organization} slot, filled from the member's own organization row
// (readable through organizations_select_member) or, when no name is known,
// the product name.
import { createContext, useContext } from "react";
import { PRODUCT_NAME } from "./productIdentity.js";

// One product name, from the identity module, so the fallback never names the
// sibling product.
export { PRODUCT_NAME };

const OrganizationNameContext = createContext(null);

export const OrganizationNameProvider = OrganizationNameContext.Provider;

export function displayOrganizationName(name) {
  const value = typeof name === "string" ? name.trim() : "";
  return value || PRODUCT_NAME;
}

export function useOrganizationName() {
  return displayOrganizationName(useContext(OrganizationNameContext));
}

// The organization's own name, or null when it is not known. A surface that
// already shows the product wordmark uses this to avoid repeating it.
export function useKnownOrganizationName() {
  const value = useContext(OrganizationNameContext);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// One read of the caller's own organization name; null on any failure, so the
// shell falls back to the product name instead of blocking.
export async function loadOrganizationName(client, organizationId) {
  if (!client || !organizationId) return null;
  try {
    const { data, error } = await client
      .from("organizations")
      .select("name")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) return null;
    return typeof data?.name === "string" ? data.name : null;
  } catch {
    return null;
  }
}
