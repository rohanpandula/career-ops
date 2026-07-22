const TOKEN_OPEN = "\uE000";
const TOKEN_CLOSE = "\uE001";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(value) {
  return escapeHtml(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function safeMarkdownHref(value) {
  const href = String(value ?? "").trim();
  if (!href || /[\u0000-\u001F\u007F]/.test(href)) return null;
  if (href.startsWith("#")) return href;
  if (/^(?:\.\.\/|\.\/|\/(?!\/))/.test(href)) return href;
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function processInline(value) {
  const tokens = [];
  const keep = (html) => {
    const index = tokens.push(html) - 1;
    return `${TOKEN_OPEN}${index}${TOKEN_CLOSE}`;
  };

  // Reserve the placeholder code points so input can never reference a token.
  let text = String(value ?? "").replace(/[\uE000\uE001]/g, "�");
  text = text.replace(/`([^`]+)`/g, (_match, code) =>
    keep(`<code style="background:var(--bg-elevated);padding:1px 4px;border-radius:2px;font-size:0.85em">${escapeHtml(code)}</code>`)
  );
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, rawHref) => {
    const href = safeMarkdownHref(rawHref);
    const safeLabel = escapeHtml(label);
    if (!href) return safeLabel;
    return keep(`<a href="${escapeAttr(href)}" target="_blank" rel="noopener" style="color:var(--accent)">${safeLabel}</a>`);
  });

  let html = escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  return html.replace(new RegExp(`${TOKEN_OPEN}(\\d+)${TOKEN_CLOSE}`, "g"), (_match, index) => tokens[Number(index)] ?? "");
}

// Deliberately small Markdown renderer. Raw HTML is always escaped and link
// schemes are allowlisted so reports, digests, and inferred content are safe
// to insert with innerHTML.
export function markdownToHtml(markdown) {
  let html = "";
  let inTable = false;
  let tableHasHeader = false;
  let inSection = false;
  const lines = String(markdown ?? "").split("\n");

  for (const line of lines) {
    if (line.startsWith("# ")) {
      if (inTable) { html += "</tbody></table>"; inTable = false; tableHasHeader = false; }
      if (inSection) { html += "</div></div>"; inSection = false; }
      html += `<h1>${processInline(line.slice(2))}</h1>`;
      continue;
    }
    if (line.startsWith("## ")) {
      if (inTable) { html += "</tbody></table>"; inTable = false; tableHasHeader = false; }
      if (inSection) html += "</div></div>";
      html += `<h2>${processInline(line.slice(3))}</h2><div class="report-section visible"><div class="section-inner">`;
      inSection = true;
      continue;
    }
    if (line.startsWith("### ")) {
      html += `<h3>${processInline(line.slice(4))}</h3>`;
      continue;
    }
    if (/^-{3,}$/.test(line)) {
      html += "<hr>";
      continue;
    }
    if (line.startsWith("|")) {
      if (!inTable) { html += "<table>"; inTable = true; tableHasHeader = false; }
      if (/^\|[\s-|]+\|$/.test(line)) continue;
      const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
      const tag = tableHasHeader ? "td" : "th";
      if (tag === "th") html += "<thead>";
      html += `<tr>${cells.map((cell) => `<${tag}>${processInline(cell)}</${tag}>`).join("")}</tr>`;
      if (tag === "th") { html += "</thead><tbody>"; tableHasHeader = true; }
      continue;
    }
    if (inTable) {
      html += "</tbody></table>";
      inTable = false;
      tableHasHeader = false;
    }
    if (!line.trim()) continue;
    html += `<p>${processInline(line)}</p>`;
  }

  if (inTable) html += "</tbody></table>";
  if (inSection) html += "</div></div>";
  return html;
}
