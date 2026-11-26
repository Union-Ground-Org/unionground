// Conservative public markdown. Donor chapter pages rendered stored CMS
// blocks and raw description text. This keep the presentation idea and
// rejects raw HTML, script URLs, images, and anything that is not an
// allowlisted inline or block mark.

// Keep the link target grammar unambiguous: each repetition consumes exactly
// one non-paren character or one flat parenthesized segment. This avoids the
// overlapping alternatives that made long malformed links expensive to scan.
const INLINE = /(\*\*[^*]+?\*\*|\*[^*]+?\*|\[[^\]]+\]\((?:[^()\s]|\([^()\s]*\))*\))/g;
const MAX_MARKDOWN_LENGTH = 50_000;
const MAX_LINE_LENGTH = 4_000;

function escapeText(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInline(value) {
  const source = String(value || "");
  let html = "";
  let cursor = 0;
  for (const match of source.matchAll(INLINE)) {
    html += escapeText(source.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      html += `<strong>${escapeText(token.slice(2, -2))}</strong>`;
    } else if (token.startsWith("*")) {
      html += `<em>${escapeText(token.slice(1, -1))}</em>`;
    } else {
      const boundary = token.indexOf("](");
      const label = escapeText(token.slice(1, boundary));
      const href = token.slice(boundary + 2, -1);
      html += /^https:\/\//i.test(href)
        ? `<a href="${escapeText(href)}" rel="noopener noreferrer">${label}</a>`
        : label;
    }
    cursor = match.index + token.length;
  }
  return html + escapeText(source.slice(cursor));
}

function headingLevel(line) {
  const match = /^(#{1,3})\s+(.+)$/.exec(line);
  return match ? { level: match[1].length, text: match[2] } : null;
}

export function sanitizePublicMarkdown(markdown) {
  const lines = String(markdown || "").slice(0, MAX_MARKDOWN_LENGTH).replaceAll("\r\n", "\n").split("\n");
  const blocks = [];
  let list = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    blocks.push(`<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.slice(0, MAX_LINE_LENGTH).trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = headingLevel(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.max(2, heading.level);
      blocks.push(`<h${level}>${renderInline(heading.text)}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      list = list || [];
      list.push(line.replace(/^[-*]\s+/, ""));
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks.join("");
}
