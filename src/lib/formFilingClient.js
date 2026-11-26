export async function downloadFormFiling(client, formId, lang = "en", fetcher = fetch) {
  const { data, error } = await client.auth.getSession();
  const token = data?.session?.access_token;
  if (error || !token) throw new Error("Sign in to download a filing copy.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetcher(`/api/form-filing?formId=${encodeURIComponent(formId)}&lang=${lang === "es" ? "es" : "en"}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(response.status === 404 ? "Filing copy unavailable." : "Could not download the filing copy.");
    if (!String(response.headers.get("content-type") || "").toLowerCase().startsWith("application/pdf")) {
      throw new Error("The filing service did not return a valid PDF.");
    }
    const blob = await response.blob();
    return new File([blob], `union-base-filing-${formId}.pdf`, { type: "application/pdf" });
  } finally {
    clearTimeout(timeout);
  }
}

export function canShareFormFiling(file, nav = globalThis.navigator) {
  return Boolean(file && nav?.share && nav?.canShare?.({ files: [file] }));
}

export async function shareFormFiling(file, nav = globalThis.navigator) {
  if (!canShareFormFiling(file, nav)) return { status: "unsupported" };
  try {
    await nav.share({ files: [file], title: "Union Ground official filing copy" });
    return { status: "shared" };
  } catch (error) {
    if (error?.name === "AbortError") return { status: "cancelled" };
    throw error;
  }
}

export function triggerFormFilingDownload(file, doc = document, urls = URL) {
  const objectUrl = urls.createObjectURL(file);
  const anchor = doc.createElement("a");
  anchor.href = objectUrl;
  anchor.download = file.name;
  doc.body.append(anchor);
  anchor.click();
  anchor.remove();
  urls.revokeObjectURL(objectUrl);
}
