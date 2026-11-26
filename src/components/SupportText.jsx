import { publicContact } from "../lib/publicContact.js";

// Locked-out copy names the support address inline. The catalogue holds plain
// strings, so this renders the canonical mailto link wherever the published
// support address appears. With no published mailbox (src/lib/publicContact.js)
// the text renders as written.
export function SupportText({ text }) {
  const support = publicContact("support");
  if (!support) return String(text ?? "");
  const { email, href } = support;
  const parts = String(text ?? "").split(email);
  return parts.flatMap((part, index) => (index === 0
    ? [part]
    : [<a key={index} href={href}>{email}</a>, part]));
}
