import { resolveSupabaseBackend } from "./_lib/backend.js";
import { authenticate, bearerToken, json, methodGuard, requireEnv, supabaseRpc } from "./_lib/http.js";
import { renderFormFilingPdf } from "../src/lib/formFilingPdf.js";
import { isShippedLanguage } from "../src/lib/languages.js";
import { filingFont } from "./_lib/filingFont.js";
import { filingShaper } from "./_lib/filingShaper.js";
import { revealFormAnswers, SEALED_FORM_TEMPLATES } from "./_lib/sensitiveContent.js";
import { sensitiveKeyring } from "./_lib/sensitiveDataCrypto.js";
import { createSensitiveServiceClient } from "./_lib/sensitiveSupabase.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(request, response) {
  if (methodGuard(request, ["GET"], () => json(response, 405, { error: "Method not allowed." }))) return;

  const backend = resolveSupabaseBackend(request);
  const { url: supabaseUrl, publishableKey, serviceRoleKey } = backend;
  if (requireEnv([supabaseUrl, publishableKey, serviceRoleKey],
    () => json(response, 503, { error: "Official filing copies are not configured." }))) return;

  const token = bearerToken(request);
  if (!token) return json(response, 401, { error: "Sign in to download a filing copy." });
  const formId = String(request.query?.formId || "");
  const lang = String(request.query?.lang || "en");
  if (!UUID.test(formId) || !isShippedLanguage(lang)) {
    return json(response, 400, { error: "A valid form and language are required." });
  }

  const user = await authenticate(supabaseUrl, publishableKey, token).catch(() => null);
  if (!user?.id) return json(response, 401, { error: "Your session expired. Sign in again." });

  let allowed;
  try {
    allowed = await supabaseRpc(supabaseUrl, publishableKey, token,
      "can_access_form_filing", { p_form_id: formId });
  } catch {
    // Collapse provider refusal, wrong scope and missing rows: callers cannot
    // use the endpoint to distinguish another member's approved form.
    return json(response, 404, { error: "Filing copy unavailable." });
  }
  if (allowed !== true) return json(response, 404, { error: "Filing copy unavailable." });

  try {
    const payload = await supabaseRpc(supabaseUrl, serviceRoleKey, serviceRoleKey,
      "get_form_filing_payload", { p_form_id: formId, p_user_id: user.id });
    if (!payload?.form || !payload?.approval?.artifactDigest) throw new Error("malformed-filing-payload");
    // Sealed FMLA answers (#5747) are opened in memory for this one response;
    // the PDF is never stored and the response is no-store.
    // Only a sealed template's marker is encryption metadata; an ordinary
    // template may answer a plain field named "sealed" (#6329).
    if (payload.form.answers?.sealed === true && SEALED_FORM_TEMPLATES.has(payload.form.template_key)) {
      const row = await createSensitiveServiceClient(supabaseUrl, serviceRoleKey).from("member_forms")
        .select("id,template_key,organization_id,answers,encrypted_content").eq("id", formId).single();
      if (row.error) throw new Error("sealed-form-unavailable");
      payload.form = { ...payload.form, answers: revealFormAnswers(row.data, sensitiveKeyring(backend.surface)) };
    }
    // Text outside WinAnsi prints exactly in the embedded font (#8701, #8716).
    // Without a readable font file the copy is still built: such characters
    // are written as [U+XXXX] codes with the copy's note, never a 503 (#8725).
    let font = null;
    try {
      font = filingFont();
    } catch (error) {
      console.error("[form-filing] filing font unavailable", { error: String(error) });
    }
    // Shaped text (Arabic, Hebrew, Devanagari) and subset fonts when the
    // shaper loads; otherwise, or if shaping fails, the unshaped copy (#8725).
    const shaper = font ? await filingShaper() : null;
    let pdf = null;
    if (shaper) {
      try {
        pdf = renderFormFilingPdf(payload, lang, { font, shaper });
      } catch (error) {
        console.error("[form-filing] shaped copy failed", { error: String(error) });
      }
    }
    pdf ??= renderFormFilingPdf(payload, lang, { font });
    response.status(200);
    response.setHeader("Content-Type", "application/pdf");
    response.setHeader("Cache-Control", "no-store, private");
    response.setHeader("Content-Disposition", `attachment; filename="union-base-filing-${formId}.pdf"`);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(Buffer.from(pdf));
  } catch (error) {
    console.error("[form-filing] generation failed", { name: error?.name || null, message: error?.message || null });
    return json(response, 503, { error: "Filing copy unavailable right now." });
  }
}
