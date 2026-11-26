// How a reviewer sees a typed signature (#8701): the typed name, marked typed,
// next to the account name. Drawn strokes never reach the browser, so a drawn
// signature keeps its plain "signed" line. `status` is get_form_filing_status.

export function FilerSignatureKindNote({ status, accountName, t }) {
  if (status?.filerSigned !== true || status?.filerSignatureKind !== "typed") return null;
  return (
    <p className="form-filing__hint" role="note">
      {t("steward.signedTyped", { name: status.filerTypedName || "", account: accountName || "" })}
    </p>
  );
}

// Co-signer names for the "Co-signed by" line, with the typed name after each
// co-signer who signed by typing.
export function cosignerNamesWithKind(cosigners, status, t) {
  const typed = new Map((status?.cosignatures || [])
    .filter((row) => row?.kind === "typed")
    .map((row) => [row.cosignerId, row.typedName || ""]));
  return (cosigners || []).map((cosigner) => (typed.has(cosigner.id)
    ? t("steward.cosignerTyped", { name: cosigner.name, typed: typed.get(cosigner.id) })
    : cosigner.name)).join(", ");
}
