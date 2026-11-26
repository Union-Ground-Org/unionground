// REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030: the four organization form
// document functions (supabase/migrations/20261030201500_organization_form_documents.sql).
// There is no table read or write path: every call is a role-gated RPC scoped
// to the caller's selected organization. Each call names its function
// literally (the RPC drift guard resolves it) and keeps the server's error
// code through MemberApiError.
import { MemberApiError } from "./memberApiError.js";

const LABEL = "Organization forms";

function resultOrThrow(result) {
  if (result?.error) throw new MemberApiError(LABEL, result.error);
  return result?.data;
}

export function createOrganizationFormDocumentsApi(client) {
  if (!client?.rpc) return null;
  return {
    listOrganizationFormDocuments: async () => resultOrThrow(await client.rpc("list_organization_form_documents")),
    getOrganizationFormDocument: async (id) => resultOrThrow(await client.rpc("get_organization_form_document", { p_id: id })),
    acceptOrganizationFormDocument: async (fields) => resultOrThrow(await client.rpc("accept_organization_form_document", {
      p_title: fields.title,
      p_form_key: fields.formKey ?? null,
      p_document_html: fields.html,
      p_source_sha256: fields.sourceSha256 ?? null,
      p_cleared_field_count: fields.clearedFieldCount ?? 0,
      p_attested: fields.attested === true,
    })),
    retireOrganizationFormDocument: async (id) => resultOrThrow(await client.rpc("retire_organization_form_document", { p_id: id })),
  };
}
