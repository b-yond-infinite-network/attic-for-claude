// SPDX-License-Identifier: MIT
// Copyright (c) 2026 B-Yond

/*
 * CLHMarkdown — a small, dependency-free Markdown renderer for Attic for Claude.
 *
 * SECURITY: all source text is HTML-escaped; only the tags this renderer emits can
 * reach the DOM. Link/image URLs are scheme-validated AND control-character-stripped
 * (the URL parser drops leading C0 controls, so "\x01javascript:" must be neutralised
 * before the scheme check). This renders stored conversation content, which is
 * untrusted. Do not add raw-HTML passthrough.
 */
var CLHMarkdown = (function () {
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  // Allow only safe URL schemes; return "" to drop. Strips control chars FIRST so a
  // smuggled "\x01javascript:..." can't slip past the scheme test and later execute.
  function safeUrl(url) {
    const u = (url || "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
    if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return ""; // other scheme -> block (javascript:, data:, ...)
    return u; // relative / anchor / bare -> keep
  }
  // Inline-code sentinels: private-use codepoints that never occur in real text (a
  // plain sentinel like " C0 " collides with prose such as "the C4 note" and crashes).
  const C_OPEN = "\uE000";
  const C_CLOSE = "\uE001";

  /* ---------- inline ---------- */
  function inline(raw) {
    const code = [];
    let t = raw.replace(/`([^`]+)`/g, (m, c) => {
      code.push(c);
      return C_OPEN + (code.length - 1) + C_CLOSE;
    });
    t = escapeHtml(t);
    // t is already HTML-escaped; only quotes still need escaping for an attribute —
    // re-running escapeAttr would double-escape '&' and break URLs containing it.
    const attrUrl = (u) => u.replace(/"/g, "&quot;");
    // images  ![alt](url)
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
      const s = safeUrl(url);
      return s ? '<img src="' + attrUrl(s) + '" alt="' + alt.replace(/"/g, "&quot;") + '" class="clh-md-img">' : alt;
    });
    // links  [text](url)
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, txt, url) => {
      const s = safeUrl(url);
      return s ? '<a href="' + attrUrl(s) + '" target="_blank" rel="noopener noreferrer nofollow">' + txt + "</a>" : txt;
    });
    // bare autolinks. '>' is excluded from the preceding char so URL text already
    // inside an <a> (from the step above) is not re-wrapped into a nested anchor.
    t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)(?=[\s<).,!?]|$)/g, (m, pre, url) => {
      const s = safeUrl(url);
      return s ? pre + '<a href="' + attrUrl(s) + '" target="_blank" rel="noopener noreferrer nofollow">' + url + "</a>" : m;
    });
    t = t.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^\w])__([^_]+?)__(?=[^\w]|$)/g, "$1<strong>$2</strong>");
    t = t.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\s][^_]*?)_(?=[^\w]|$)/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~]+?)~~/g, "<del>$1</del>");
    // restore code spans (guard against an out-of-range index)
    t = t.replace(new RegExp(C_OPEN + "(\\d+)" + C_CLOSE, "g"), (m, i) =>
      '<code class="clh-md-code">' + escapeHtml(code[+i] != null ? code[+i] : "") + "</code>"
    );
    return t;
  }

  /* ---------- block-level regexes & helpers ---------- */
  const RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
  const FENCE_ANY = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/; // fence at any indent (inside lists)
  const BQ = /^ {0,3}> ?(.*)$/;
  const UL = /^( *)([-*+])\s+(.*)$/;
  const OL = /^( *)(\d+)[.)]\s+(.*)$/;
  const isBlank = (l) => /^\s*$/.test(l);
  const looksTable = (l) => /\|/.test(l);
  // Table separator row, e.g. |---|:--:|. Single char class = linear (no ReDoS).
  const isTableSep = (l) => l != null && /^[\s|:-]+$/.test(l) && l.indexOf("-") >= 0 && l.indexOf("|") >= 0;

  function dedent(arr) {
    const widths = arr.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
    const min = widths.length ? Math.min.apply(null, widths) : 0;
    return arr.map((l) => l.slice(min));
  }

  function renderCodeBlock(lang, lines) {
    return (
      '<div class="clh-md-pre"><div class="clh-md-pre-head"><span class="clh-md-lang">' +
      (lang ? escapeHtml(lang) : "") +
      '</span><button class="clh-md-copy" type="button" data-clh-copy>Copy</button></div>' +
      '<pre class="clh-md-prebody"><code>' +
      escapeHtml(lines.join("\n")) +
      "</code></pre></div>"
    );
  }

  function renderTable(header, rows, aligns) {
    const cell = (c, tag, i) => {
      const a = aligns[i] ? ' style="text-align:' + aligns[i] + '"' : "";
      return "<" + tag + a + ">" + inline(c.trim()) + "</" + tag + ">";
    };
    const h = "<tr>" + header.map((c, i) => cell(c, "th", i)).join("") + "</tr>";
    const b = rows.map((r) => "<tr>" + r.map((c, i) => cell(c, "td", i)).join("") + "</tr>").join("");
    return '<table class="clh-md-table"><thead>' + h + "</thead><tbody>" + b + "</tbody></table>";
  }

  const splitRow = (l) =>
    l
      .replace(/^\s*\|?/, "")
      .replace(/\|?\s*$/, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.replace(/\\\|/g, "|"));

  /* ---------- nested-list parsing (indentation stack) ---------- */
  function parseList(lines, start) {
    const listHtml = (node) => {
      const tag = node.type === "ol" ? "ol" : "ul";
      return "<" + tag + ' class="clh-md-' + tag + '">' + node.items.join("") + "</" + tag + ">";
    };
    const attachToParent = (node, parent) => {
      const html = listHtml(node);
      if (parent.items.length) parent.items[parent.items.length - 1] = parent.items[parent.items.length - 1].replace(/<\/li>\s*$/, html + "</li>");
      else parent.items.push(html);
    };
    const root = [];
    const stack = [{ indent: -1, type: null, items: root }];
    let i = start;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (isBlank(line)) {
        if (i + 1 < lines.length && (UL.test(lines[i + 1]) || OL.test(lines[i + 1]))) continue;
        break;
      }
      let m = UL.exec(line),
        type = "ul";
      if (!m) {
        m = OL.exec(line);
        type = "ol";
      }
      if (!m) {
        const top = stack[stack.length - 1];
        if (!top.items.length) break;
        // fenced code block directly under a list item -> render it inside the <li>
        const fm = FENCE_ANY.exec(line);
        if (fm) {
          const fence = fm[1][0];
          const closer = new RegExp("^\\s*" + fence + "{3,}\\s*$");
          const body = [];
          i++;
          while (i < lines.length && !closer.test(lines[i])) {
            body.push(lines[i]);
            i++;
          }
          const html = renderCodeBlock(fm[2], dedent(body));
          top.items[top.items.length - 1] = top.items[top.items.length - 1].replace(/<\/li>\s*$/, html + "</li>");
          continue; // loop's i++ steps past the closing fence
        }
        // otherwise: plain continuation text for the current item
        top.items[top.items.length - 1] = top.items[top.items.length - 1].replace(/<\/li>\s*$/, " " + inline(line.trim()) + "</li>");
        continue;
      }
      const indent = m[1].length;
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) {
        const node = stack.pop();
        attachToParent(node, stack[stack.length - 1]);
      }
      let top = stack[stack.length - 1];
      if (indent > top.indent) {
        const node = { indent, type, items: [] };
        stack.push(node);
        top = node;
      }
      if (!top.type) top.type = type;
      top.items.push("<li>" + inline(m[3]) + "</li>");
    }
    while (stack.length > 1) {
      const node = stack.pop();
      attachToParent(node, stack[stack.length - 1]);
    }
    return [root.join(""), i];
  }

  /* ---------- block parser ---------- */
  function render(src) {
    if (!src) return "";
    const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    const isTableAt = (idx) => looksTable(lines[idx]) && isTableSep(lines[idx + 1]);
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        i++;
        continue;
      }
      const f = FENCE.exec(line);
      if (f) {
        const fence = f[1][0];
        const body = [];
        i++;
        while (i < lines.length && !new RegExp("^ {0,3}" + fence + "{3,}\\s*$").test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        out.push(renderCodeBlock(f[2], body));
        continue;
      }
      if (RULE.test(line)) {
        out.push('<hr class="clh-md-hr">');
        i++;
        continue;
      }
      const h = HEADING.exec(line);
      if (h) {
        const lvl = h[1].length;
        out.push("<h" + lvl + ' class="clh-md-h' + lvl + '">' + inline(h[2]) + "</h" + lvl + ">");
        i++;
        continue;
      }
      if (BQ.test(line)) {
        const inner = [];
        while (i < lines.length && BQ.test(lines[i])) {
          inner.push(BQ.exec(lines[i])[1]);
          i++;
        }
        out.push('<blockquote class="clh-md-quote">' + render(inner.join("\n")) + "</blockquote>");
        continue;
      }
      if (isTableAt(i)) {
        const header = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => {
          const t = c.trim();
          if (/^:-+:$/.test(t)) return "center";
          if (/^-+:$/.test(t)) return "right";
          if (/^:-+$/.test(t)) return "left";
          return "";
        });
        i += 2;
        const rows = [];
        while (i < lines.length && looksTable(lines[i]) && !isBlank(lines[i])) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        out.push(renderTable(header, rows, aligns));
        continue;
      }
      if (UL.test(line) || OL.test(line)) {
        const [html, next] = parseList(lines, i);
        out.push(html);
        i = next;
        continue;
      }
      // paragraph: gather until a blank line or the start of another block
      const para = [];
      while (
        i < lines.length &&
        !isBlank(lines[i]) &&
        !FENCE.test(lines[i]) &&
        !HEADING.test(lines[i]) &&
        !RULE.test(lines[i]) &&
        !BQ.test(lines[i]) &&
        !UL.test(lines[i]) &&
        !OL.test(lines[i]) &&
        !isTableAt(i)
      ) {
        para.push(lines[i]);
        i++;
      }
      out.push('<p class="clh-md-p">' + inline(para.join("\n")).replace(/\n/g, "<br>") + "</p>");
    }
    return out.join("");
  }

  return { render, escapeHtml };
})();

if (typeof window !== "undefined") window.CLHMarkdown = CLHMarkdown;
