// SPDX-License-Identifier: MIT
// Copyright (c) 2026 B-Yond

/*
 * Attic for Claude — content script.
 * Injects local (imported) conversations into:
 *   - the claude.ai sidebar recents list,
 *   - the /recents "All chats" table (with local search),
 * renders them in a read-only overlay, and "continues" any of them by seeding a
 * new chat with the prior conversation (including text-attachment content) as context.
 */
(function () {
  if (window.__CLH_LOADED__) return;
  window.__CLH_LOADED__ = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let settings = null;
  let index = [];
  let consumed = {};
  let searchMap = null; // uuid -> lowercased search blob (lazy)
  let nativeDatesCache = null; // uuid -> updated_at for the account's native chats
  let nativeDatesAt = 0;
  let observer = null; // main MutationObserver (paused while the overlay is open)

  function getOrg() {
    const m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Fetch the account's native conversation dates so local entries can be sorted
  // in among them (needed to interleave by date rather than dumping at the top).
  async function getNativeDates() {
    if (nativeDatesCache && Date.now() - nativeDatesAt < 60000) return nativeDatesCache;
    const org = getOrg();
    if (!org) return nativeDatesCache || {};
    try {
      const r = await fetch("/api/organizations/" + org + "/chat_conversations?limit=1000", {
        headers: { "anthropic-client-platform": "web_claude_ai" },
        credentials: "include",
      });
      if (!r.ok) return nativeDatesCache || {};
      const list = await r.json();
      const map = {};
      for (const c of list) if (c && c.uuid) map[c.uuid] = c.updated_at || c.created_at;
      nativeDatesCache = map;
      nativeDatesAt = Date.now();
      return map;
    } catch (_) {
      return nativeDatesCache || {};
    }
  }

  async function loadState() {
    settings = await CLHStore.getSettings();
    index = await CLHStore.getIndex();
    consumed = await CLHStore.getConsumed();
  }

  async function ensureSearchIndex() {
    if (searchMap) return searchMap;
    const arr = await CLHStore.getSearchIndex();
    searchMap = {};
    for (const e of arr) searchMap[e.uuid] = e.t || "";
    return searchMap;
  }

  /* ---------- filtering ---------- */

  function inRange(dateStr) {
    if (!settings) return true;
    const t = new Date(dateStr || 0).getTime();
    if (settings.dateFrom && t < new Date(settings.dateFrom).getTime()) return false;
    if (settings.dateTo && t > new Date(settings.dateTo).getTime() + 86400000) return false;
    return true;
  }

  function baseEntries() {
    return index
      .filter((e) => !consumed[e.uuid])
      .filter((e) => inRange(e.updated_at || e.created_at))
      .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  }

  function matchEntries(query) {
    const entries = baseEntries();
    if (!query) return entries;
    // token-AND: every whitespace-separated term must appear in title or content blob
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((e) => {
      const hay = (e.name || "").toLowerCase() + " " + (searchMap ? searchMap[e.uuid] || "" : "");
      return tokens.every((t) => hay.includes(t));
    });
  }

  const titleOf = (e) => (e && e.name && e.name.trim()) || "Untitled chat";
  function fmtDate(s) {
    try {
      return new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch (_) {
      return s || "";
    }
  }
  function fmtDay(s) {
    try {
      return new Date(s).toLocaleDateString(undefined, { dateStyle: "medium" });
    } catch (_) {
      return s || "";
    }
  }

  /* ---------- sidebar injection ---------- */

  function findRecentsUL() {
    const uls = [...document.querySelectorAll("ul")].filter((ul) => ul.querySelector('a[href^="/chat/"]'));
    if (!uls.length) return document.querySelector("ul.flex.flex-col.gap-px") || null;
    const isVisible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
    return uls.find(isVisible) || uls[0];
  }

  function buildSidebarLi(e) {
    const li = document.createElement("li");
    li.className = "clh-anchor clh-item";
    li.setAttribute("data-clh-uuid", e.uuid);
    const a = document.createElement("a");
    a.className = "clh-link";
    a.href = "#clh/" + e.uuid;
    a.title = titleOf(e) + "  ·  local archive · " + fmtDate(e.updated_at || e.created_at);
    a.innerHTML =
      '<span class="clh-halo"></span><span class="clh-title"></span>' +
      (e.hasImages ? '<span class="clh-imgmark" title="had image attachments">🖼</span>' : "");
    a.querySelector(".clh-title").textContent = titleOf(e);
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openOverlay(e.uuid);
    });
    li.appendChild(a);
    return li;
  }

  function removeSidebarInjected() {
    document.querySelectorAll(".clh-anchor").forEach((n) => n.remove());
  }

  const uuidFromHref = (href) => ((href || "").split("/chat/")[1] || "").split(/[/?#]/)[0];

  // Insert local entries interleaved by date among the native recents. Falls back to
  // a labelled group at the top only until native dates are available.
  function ensureSidebar() {
    if (!settings || !settings.enabled) {
      removeSidebarInjected();
      return;
    }
    const ul = findRecentsUL();
    if (!ul) return;
    if (ul.querySelector(".clh-anchor")) return; // still present — React hasn't wiped it
    // Sidebar shows only the most recent N (the rest live on the All-chats page).
    const limit = settings.sidebarLimit || 0;
    const all = baseEntries();
    const entries = limit > 0 ? all.slice(0, limit) : all;
    if (!entries.length) return;

    const nativeLis = [...ul.children].filter(
      (li) => li.tagName === "LI" && !li.classList.contains("clh-anchor") && li.querySelector('a[href^="/chat/"]')
    );
    const dateMap = nativeDatesCache || {};

    if (!nativeLis.length || !Object.keys(dateMap).length) {
      // fallback until native dates load: labelled group at the top
      const frag = document.createDocumentFragment();
      const header = document.createElement("li");
      header.className = "clh-anchor clh-header";
      header.innerHTML =
        '<div class="clh-header-inner"><span class="clh-dot"></span><span>Local archive</span><span class="clh-count"></span></div>';
      header.querySelector(".clh-count").textContent = String(entries.length);
      frag.appendChild(header);
      for (const e of entries) frag.appendChild(buildSidebarLi(e));
      ul.insertBefore(frag, ul.firstChild);
      return;
    }

    // interleave by date (entries and nativeLis are both newest-first)
    const dateOf = (li) => new Date(dateMap[uuidFromHref(li.querySelector('a[href^="/chat/"]').getAttribute("href"))] || 0).getTime();
    for (const e of entries) {
      const ed = new Date(e.updated_at || e.created_at).getTime();
      const li = buildSidebarLi(e);
      const target = nativeLis.find((nli) => ed >= dateOf(nli));
      if (target) ul.insertBefore(li, target);
      else ul.appendChild(li);
    }
  }

  /* ---------- /recents "All chats" table injection + local search ---------- */

  function findRecentsTbody() {
    if (location.pathname !== "/recents") return null;
    const main = document.querySelector("main") || document.body;
    const a = main.querySelector('a[href^="/chat/"]');
    return a ? a.closest("tbody") : null;
  }

  function currentSearchQuery() {
    const inp = document.querySelector('input[placeholder*="Search" i], input[type="search"]');
    const fromInput = inp ? (inp.value || "").trim() : "";
    let fromUrl = "";
    try {
      fromUrl = new URL(location.href).searchParams.get("search") || "";
    } catch (_) {}
    return fromInput || fromUrl;
  }

  // Build a row that MIRRORS the native cell structure (the table is table-layout:fixed,
  // so a single colspan cell would reset every column width and collapse the native rows).
  // Content goes in the middle cell (index 1), matching claude's [spacer, content, spacer].
  function makeCells(cols, contentHTML) {
    const contentIdx = Math.min(1, cols - 1);
    let html = "";
    for (let i = 0; i < cols; i++) html += i === contentIdx ? "<td>" + contentHTML + "</td>" : "<td></td>";
    return html;
  }

  function buildRecentsRow(e, cols) {
    const tr = document.createElement("tr");
    tr.className = "clh-recents-row";
    tr.setAttribute("data-clh-uuid", e.uuid);
    tr.innerHTML = makeCells(
      cols,
      '<div class="clh-rrow"><span class="clh-halo"></span>' +
        '<span class="clh-rtitle"></span>' +
        (e.hasImages ? '<span class="clh-imgmark">🖼</span>' : "") +
        '<span class="clh-tag">local</span><span class="clh-rdate"></span></div>'
    );
    tr.querySelector(".clh-rtitle").textContent = titleOf(e);
    tr.querySelector(".clh-rdate").textContent = fmtDay(e.updated_at || e.created_at);
    tr.addEventListener("click", (ev) => {
      // in claude's selection mode, a row click toggles its checkbox (like native rows)
      if (inSelectMode()) {
        const cb = tr.querySelector(".clh-cb");
        if (cb && ev.target !== cb) {
          cb.checked = !cb.checked;
          syncNativeDeleteBtn(); // setting .checked in JS fires no 'change' event, so sync here
        }
        return;
      }
      openOverlay(e.uuid);
    });
    return tr;
  }

  /* ---------- native "Select chats" integration (/recents) ---------- */

  const inSelectMode = () => !!document.querySelector("[data-selection-mode]");
  const checkedLocalUuids = () =>
    [...document.querySelectorAll(".clh-recents-row .clh-cb")].filter((cb) => cb.checked).map((cb) => cb.getAttribute("data-clh-uuid"));

  // Add/remove a checkbox on each local row to mirror claude's selection mode.
  function decorateSelectMode() {
    const on = inSelectMode();
    document.querySelectorAll(".clh-recents-row").forEach((row) => {
      const firstCell = row.querySelector("td"); // the checkbox column, aligns with native
      if (!firstCell) return;
      const has = row.querySelector(".clh-cb");
      if (on && !has) {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "clh-cb";
        cb.setAttribute("data-clh-uuid", row.getAttribute("data-clh-uuid") || "");
        cb.addEventListener("click", (e) => e.stopPropagation());
        cb.addEventListener("change", syncNativeDeleteBtn);
        firstCell.appendChild(cb);
        row.classList.add("clh-selecting");
      } else if (!on && has) {
        has.remove();
        row.classList.remove("clh-selecting");
      }
    });
    if (on) syncNativeDeleteBtn();
  }

  // claude's "Delete" is disabled when it has 0 native rows selected — but we may have
  // local rows checked. Enable it so the click (and its confirmation) can fire.
  function nativeSelectedCount() {
    const el = [...document.querySelectorAll("span, div, button")].find(
      (e) => e.children.length === 0 && /^\d+\s+selected$/i.test((e.textContent || "").trim())
    );
    return el ? parseInt(el.textContent, 10) || 0 : 0;
  }
  function actionBarDeleteBtn() {
    return [...document.querySelectorAll("button")].find(
      (b) => /^\s*delete\s*$/i.test(b.textContent || "") && !b.closest('[role="alertdialog"], [role="dialog"]')
    );
  }
  function syncNativeDeleteBtn() {
    if (!inSelectMode()) return;
    const del = actionBarDeleteBtn();
    if (!del) return;
    const want = nativeSelectedCount() > 0 || !!document.querySelector(".clh-recents-row .clh-cb:checked");
    if (want && del.disabled) {
      del.disabled = false;
      del.style.pointerEvents = "auto";
      del.style.opacity = "1";
    } else if (!want && !del.disabled) {
      del.disabled = true;
      del.style.pointerEvents = "";
      del.style.opacity = "";
    }
  }

  let pendingLocalDelete = [];
  let pendingNativeCount = 0; // native chats selected alongside local ones, for the toast total

  async function performLocalDelete(uuids) {
    const total = (pendingNativeCount || 0) + uuids.length;
    pendingNativeCount = 0;
    for (const u of uuids) {
      await CLHStore.deleteConversation(u);
      index = index.filter((x) => x.uuid !== u);
      if (searchMap) delete searchMap[u];
    }
    const tb = findRecentsTbody();
    if (tb) tb.__clhSig = null;
    scheduleRender();
    showDeleteToast(total);
  }

  // Claude shows no toast for bulk deletes (and its single-delete toast has no count), so
  // when local chats are involved we show our own "N chats deleted" toast with the total.
  function showDeleteToast(total) {
    if (!total) return;
    const existing = document.getElementById("clh-toast");
    if (existing) existing.remove();
    const el = document.createElement("div");
    el.id = "clh-toast";
    el.setAttribute("role", "status");
    el.textContent = total + " chat" + (total === 1 ? "" : "s") + " deleted";
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("clh-toast-in"));
    setTimeout(() => {
      el.classList.remove("clh-toast-in");
      setTimeout(() => el.remove(), 300);
    }, 2600);
  }

  // Our own confirmation (matches claude's alertdialog) for local-only selections, where
  // claude shows no dialog because it has nothing of its own selected.
  function showLocalDeleteConfirm(uuids) {
    const existing = document.getElementById("clh-confirm");
    if (existing) existing.remove();
    const n = uuids.length;
    const ov = document.createElement("div");
    ov.id = "clh-confirm";
    ov.innerHTML =
      '<div class="clh-cm-box" role="alertdialog" aria-modal="true">' +
      '<div class="clh-cm-title"></div><div class="clh-cm-body"></div>' +
      '<div class="clh-cm-actions"><button class="clh-cm-cancel" type="button">Cancel</button>' +
      '<button class="clh-cm-delete" type="button">Delete</button></div></div>';
    ov.querySelector(".clh-cm-title").textContent = "Delete " + n + " chat" + (n === 1 ? "" : "s");
    ov.querySelector(".clh-cm-body").textContent =
      "Are you sure you want to permanently delete " + (n === 1 ? "this chat" : "these " + n + " chats") + "? This cannot be undone.";
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector(".clh-cm-cancel").addEventListener("click", close);
    ov.addEventListener("click", (e) => e.target === ov && close());
    ov.querySelector(".clh-cm-delete").addEventListener("click", () => {
      close();
      performLocalDelete(uuids);
    });
  }

  // Fold the local selection count into claude's "Delete N chats" confirmation title/body.
  function updateDialogCount(extra) {
    if (!extra) return;
    const dlg = document.querySelector('[role="alertdialog"], [role="dialog"]');
    if (!dlg) return;
    const leaves = [...dlg.querySelectorAll("*")].filter((e) => e.children.length === 0);
    const title = leaves.find((e) => /^Delete\s+\d+\s+chat/i.test((e.textContent || "").trim()));
    if (!title) return;
    const m = (title.textContent || "").match(/(\d+)/);
    if (!m) return;
    const total = parseInt(m[1], 10) + extra;
    title.textContent = "Delete " + total + " chat" + (total === 1 ? "" : "s");
    const body = leaves.find((e) => /permanently delete/i.test(e.textContent || ""));
    if (body) {
      body.textContent =
        "Are you sure you want to permanently delete " + (total === 1 ? "this chat" : "these chats") + "? This cannot be undone.";
    }
  }

  // Hook claude's action bar + its delete confirmation. Delete NEVER acts instantly — it
  // waits for the confirmation dialog (claude's alertdialog, or our own for local-only).
  // "Move to project" deliberately ignores local rows (they can't go in a project).
  function hookSelectActions() {
    const dialogSel = '[role="alertdialog"], [role="dialog"]';
    document.addEventListener(
      "click",
      (e) => {
        const btn = e.target.closest && e.target.closest("button");
        if (!btn) return;
        const label = (btn.textContent || "").trim().toLowerCase();
        const inDialog = !!btn.closest(dialogSel);

        // a pending delete is resolved by the confirmation dialog's Delete / Cancel
        if (pendingLocalDelete.length && inDialog) {
          if (label.includes("delete")) {
            const uu = pendingLocalDelete;
            pendingLocalDelete = [];
            performLocalDelete(uu);
          } else if (label.includes("cancel")) {
            pendingLocalDelete = [];
          }
          return;
        }
        if (!inSelectMode() || inDialog) return;

        if (label.includes("select all")) {
          setTimeout(() => document.querySelectorAll(".clh-recents-row .clh-cb").forEach((cb) => (cb.checked = true)), 0);
        } else if (label.includes("deselect")) {
          document.querySelectorAll(".clh-recents-row .clh-cb").forEach((cb) => (cb.checked = false));
        } else if (label === "delete") {
          const uuids = checkedLocalUuids();
          if (!uuids.length) return; // nothing local selected — claude fully handles it
          pendingLocalDelete = uuids; // don't delete yet — wait for confirmation
          pendingNativeCount = nativeSelectedCount(); // remember native count for the toast total
          setTimeout(() => {
            if (!pendingLocalDelete.length) return;
            if (!document.querySelector(dialogSel)) {
              // claude showed no dialog (local-only selection) — show our own
              const uu = pendingLocalDelete;
              pendingLocalDelete = [];
              showLocalDeleteConfirm(uu);
            } else {
              // claude's dialog is up (native + local) — fold the local count into its total
              updateDialogCount(uuids.length);
            }
          }, 300);
        }
        // "move to project" / "cancel": leave local rows untouched
      },
      true
    );
  }

  function renderRecentsRows() {
    const tbody = findRecentsTbody();
    if (!tbody) return;
    if (!settings || !settings.enabled) {
      tbody.querySelectorAll(".clh-recents-row, .clh-recents-divider").forEach((n) => n.remove());
      return;
    }
    const query = currentSearchQuery();
    const entries = matchEntries(query);
    const nativeTrs = [...tbody.children].filter(
      (tr) => tr.tagName === "TR" && !tr.className.includes("clh-recents") && tr.querySelector('a[href^="/chat/"]')
    );
    const firstNative = nativeTrs[0] ? uuidFromHref(nativeTrs[0].querySelector('a[href^="/chat/"]').getAttribute("href")) : "";
    // Idempotency: if the DOM already reflects the intended state, do nothing — otherwise
    // the observer would see our own mutations and re-render forever.
    const sig = [query, entries.length, entries[0] && entries[0].uuid, nativeTrs.length, firstNative].join("|");
    if (tbody.__clhSig === sig && tbody.querySelector(".clh-recents-row, .clh-recents-divider")) return;
    tbody.__clhSig = sig;

    tbody.querySelectorAll(".clh-recents-row, .clh-recents-divider").forEach((n) => n.remove());
    if (query && !entries.length) return;
    // Number of <td> cells our rows should have — must match the table's real column
    // count so injected rows mirror native structure (read from the header, which already
    // reflects selection mode's extra checkbox column).
    const table = tbody.closest("table");
    const headTr = table && table.querySelector("thead tr");
    const cols = (headTr && headTr.children.length) || (nativeTrs[0] && nativeTrs[0].children.length) || 3;
    const dateMap = nativeDatesCache || {};

    // No active search + we know native dates -> interleave by date (matches native order).
    if (!query && nativeTrs.length && Object.keys(dateMap).length) {
      const dateOf = (tr) => new Date(dateMap[uuidFromHref(tr.querySelector('a[href^="/chat/"]').getAttribute("href"))] || 0).getTime();
      for (const e of entries) {
        const ed = new Date(e.updated_at || e.created_at).getTime();
        const row = buildRecentsRow(e, cols);
        const target = nativeTrs.find((tr) => ed >= dateOf(tr));
        if (target) tbody.insertBefore(row, target);
        else tbody.appendChild(row);
      }
      return;
    }

    // Search results (or dates unavailable): grouped block at the top.
    const frag = document.createDocumentFragment();
    const divider = document.createElement("tr");
    divider.className = "clh-recents-divider";
    divider.innerHTML = makeCells(cols, '<div class="clh-div-inner"><span class="clh-dot"></span><span></span></div>');
    divider.querySelector(".clh-div-inner span:last-child").textContent =
      (query ? "Local matches" : "Local archive") + " · " + entries.length;
    frag.appendChild(divider);
    for (const e of entries) frag.appendChild(buildRecentsRow(e, cols));
    tbody.insertBefore(frag, tbody.firstChild);
  }

  /* ---------- overlay (read-only viewer + continue box) ---------- */

  function closeOverlay() {
    const ov = document.getElementById("clh-overlay");
    if (ov) ov.remove();
    document.removeEventListener("keydown", escClose);
    if (observer) observer.observe(document.documentElement, { childList: true, subtree: true }); // resume
  }
  function escClose(e) {
    if (e.key === "Escape") closeOverlay();
  }

  // Render an assistant turn's structured blocks: markdown text, collapsible thinking,
  // and tool-use pills (in place of claude.ai's "not supported" export placeholder).
  function renderBlocks(container, blocks) {
    for (const b of blocks) {
      if (b.t === "text") {
        const d = document.createElement("div");
        d.className = "clh-md";
        d.innerHTML = CLHMarkdown.render(b.v || "");
        container.appendChild(d);
      } else if (b.t === "think") {
        const det = document.createElement("details");
        det.className = "clh-think";
        det.innerHTML = '<summary class="clh-think-sum">Thought process</summary><div class="clh-md clh-think-body"></div>';
        det.querySelector(".clh-think-body").innerHTML = CLHMarkdown.render(b.v || "");
        container.appendChild(det);
      } else if (b.t === "tool") {
        const pill = document.createElement("div");
        pill.className = "clh-tool";
        pill.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.1-.6-.6-2.1z"/></svg><span></span>';
        pill.querySelector("span").textContent = b.v || "Used a tool";
        container.appendChild(pill);
      }
    }
  }

  function renderAttachments(container, m) {
    const atts = m.attachments || [];
    const files = m.files || [];
    if (!atts.length && !files.length) return;
    const wrap = document.createElement("div");
    wrap.className = "clh-atts";
    for (const a of atts) {
      const d = document.createElement("details");
      d.className = "clh-att";
      const sum = document.createElement("summary");
      sum.textContent = "📎 " + a.name + (a.type ? " · " + a.type : "");
      const pre = document.createElement("pre");
      pre.className = "clh-att-body";
      pre.textContent = a.content || "(no extracted text)";
      d.appendChild(sum);
      d.appendChild(pre);
      wrap.appendChild(d);
    }
    for (const f of files) {
      const chip = document.createElement("div");
      chip.className = "clh-file-chip";
      chip.textContent = (f.image ? "🖼 " : "📎 ") + f.name + " — not in export";
      chip.title = "The original " + (f.image ? "image" : "file") + " isn't included in the data export.";
      wrap.appendChild(chip);
    }
    container.appendChild(wrap);
  }

  async function openOverlay(uuid) {
    const conv = await CLHStore.getConv(uuid);
    if (!conv) {
      console.warn("[CLH] conversation not found:", uuid);
      return;
    }
    closeOverlay();
    const chevron =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
    const trash =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6"/></svg>';
    const upArrow =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
    const ov = document.createElement("div");
    ov.id = "clh-overlay";
    ov.innerHTML =
      '<div class="clh-ov-inner">' +
      '  <header class="clh-ov-head">' +
      '    <button class="clh-iconbtn clh-back" type="button">' + chevron + "Back</button>" +
      '    <div class="clh-ov-titles"><div class="clh-ov-title"></div>' +
      '      <div class="clh-ov-sub"><span class="clh-dot"></span><span class="clh-ov-meta"></span></div></div>' +
      '    <div class="clh-ov-actions">' +
      '      <button class="clh-iconbtn clh-danger" data-clh-delete type="button" title="Delete from local storage">' + trash + "</button>" +
      "    </div>" +
      "  </header>" +
      '  <div class="clh-ov-scroll"><div class="clh-thread"></div></div>' +
      '  <div class="clh-ov-composer">' +
      '    <div class="clh-compose-note">Send to continue this as a <b>new</b> Claude chat — the prior conversation (and any text-file content) is added as context.</div>' +
      '    <div class="clh-compose-row">' +
      '      <textarea class="clh-textarea" rows="1" placeholder="Continue this conversation…"></textarea>' +
      '      <button class="clh-send" type="button" title="Continue in a new chat">' + upArrow + "</button>" +
      "    </div>" +
      "  </div>" +
      "</div>";
    document.body.appendChild(ov);
    if (observer) observer.disconnect(); // pause page-wide observation while the modal is open (perf)

    ov.querySelector(".clh-ov-title").textContent = titleOf(conv);
    const imgCount = conv.messages.reduce((n, m) => n + (m.files || []).filter((f) => f.image).length, 0);
    ov.querySelector(".clh-ov-meta").textContent =
      "Local archive · read-only · " +
      conv.messages.length +
      " messages · " +
      fmtDate(conv.created_at) +
      (imgCount ? " · " + imgCount + " image(s) not in export" : "");

    const thread = ov.querySelector(".clh-thread");
    for (const m of conv.messages) {
      const row = document.createElement("div");
      row.className = "clh-msg " + (m.sender === "human" ? "clh-human" : "clh-assistant");
      const bubble = document.createElement("div");
      bubble.className = "clh-bubble";
      if (m.sender === "human") {
        bubble.textContent = m.text || ""; // human turns are plain text (Anthropic Sans bubble)
      } else if (m.blocks && m.blocks.length) {
        renderBlocks(bubble, m.blocks); // rich turns: text + thinking + tool-use blocks
      } else {
        const md = document.createElement("div");
        md.className = "clh-md";
        md.innerHTML = CLHMarkdown.render(m.text || ""); // old-format fallback
        bubble.appendChild(md);
      }
      row.appendChild(bubble);
      renderAttachments(row, m);
      thread.appendChild(row);
    }

    const ta = ov.querySelector(".clh-textarea");
    const doSend = () => {
      const v = ta.value.trim();
      if (v) continueConversation(uuid, v);
    };
    ov.querySelector(".clh-send").addEventListener("click", doSend);
    ov.querySelector(".clh-back").addEventListener("click", closeOverlay);

    // delete with an inline confirmation (no browser dialog)
    const actions = ov.querySelector(".clh-ov-actions");
    ov.querySelector("[data-clh-delete]").addEventListener("click", () => {
      actions.innerHTML =
        '<div class="clh-confirm"><span>Delete permanently?</span>' +
        '<button class="clh-confirm-yes" type="button">Delete</button>' +
        '<button class="clh-confirm-no" type="button">Cancel</button></div>';
      actions.querySelector(".clh-confirm-no").addEventListener("click", () => openOverlay(uuid)); // re-render restores the delete button
      actions.querySelector(".clh-confirm-yes").addEventListener("click", async () => {
        await CLHStore.deleteConversation(uuid);
        index = index.filter((e) => e.uuid !== uuid);
        if (searchMap) delete searchMap[uuid];
        closeOverlay();
        removeSidebarInjected();
        scheduleRender();
      });
    });

    ov.addEventListener("click", (e) => {
      const copyBtn = e.target.closest && e.target.closest("[data-clh-copy]");
      if (copyBtn) {
        const code = copyBtn.closest(".clh-md-pre") && copyBtn.closest(".clh-md-pre").querySelector("code");
        if (code && navigator.clipboard) {
          navigator.clipboard.writeText(code.textContent).then(
            () => {
              copyBtn.textContent = "Copied";
              setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
            },
            () => {}
          );
        }
        return;
      }
      if (e.target === ov) closeOverlay();
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    });
    document.addEventListener("keydown", escClose);
    ta.focus();
  }

  /* ---------- continuation (seed a new chat) ---------- */

  function buildSeed(conv, userMessage) {
    const includeAtt = !settings || settings.includeAttachments !== false;
    const L = [];
    L.push(
      "I'm continuing a previous conversation from my local Claude archive. The full prior conversation is included below as context — please read all of it, then respond to my new message at the very end as a natural continuation."
    );
    L.push("");
    L.push('════════ PRIOR CONVERSATION: "' + titleOf(conv) + '" (' + fmtDate(conv.created_at) + ") ════════");
    L.push("");
    for (const m of conv.messages) {
      L.push(m.sender === "human" ? "🧑 Human:" : "🤖 Assistant:");
      if (m.text) L.push(m.text);
      if (includeAtt && m.attachments) {
        for (const a of m.attachments) {
          L.push("");
          L.push("[Attached file: " + a.name + (a.type ? " (" + a.type + ")" : "") + "]");
          if (a.content) L.push(a.content);
        }
      }
      if (m.files) {
        for (const f of m.files) {
          L.push("[" + (f.image ? "Image" : "File") + " originally attached: " + f.name + " — not included in this archive]");
        }
      }
      L.push("");
    }
    L.push("════════ END OF PRIOR CONVERSATION ════════");
    L.push("");
    L.push("My new message:");
    L.push(userMessage);
    return L.join("\n");
  }

  async function continueConversation(uuid, userMessage) {
    const conv = await CLHStore.getConv(uuid);
    if (!conv) return;
    const seed = buildSeed(conv, userMessage);
    await CLHStore.setPendingSeed({
      seed,
      model: (settings && settings.continueModel) || null,
    });
    await CLHStore.markConsumed(uuid, {});
    consumed[uuid] = { at: Date.now() };
    closeOverlay();
    location.assign("https://claude.ai/new");
  }

  /* ---------- receiving side: fill composer + apply prefs on /new ---------- */

  function getProseMirror() {
    const ci = document.querySelector('[data-testid="chat-input"]');
    if (!ci) return null;
    return ci.querySelector(".ProseMirror") || ci;
  }

  async function fillComposer(text) {
    let pm = null;
    for (let i = 0; i < 50 && !pm; i++) {
      pm = getProseMirror();
      if (!pm) await sleep(150);
    }
    if (!pm) return false;
    pm.focus();
    try {
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
    } catch (_) {}
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    pm.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(200);
    const host = document.querySelector('[data-testid="chat-input"]');
    return !!(host && (host.textContent || "").length > 0);
  }

  // Best-effort: open the model picker and choose a model whose label contains `label`.
  async function applyModel(label) {
    if (!label) return;
    try {
      const btn = document.querySelector('[data-testid="model-selector-dropdown"]');
      if (!btn) return;
      btn.click();
      await sleep(350);
      const items = [...document.querySelectorAll('[role="menuitem"], [role="option"], button, a')];
      const target = items.find((i) => (i.textContent || "").toLowerCase().includes(label.toLowerCase()));
      if (target) {
        target.click();
        await sleep(150);
      } else {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
    } catch (_) {}
  }

  let seedInFlight = false;
  async function handlePendingSeed() {
    if (location.pathname !== "/new" || seedInFlight) return;
    const pending = await CLHStore.peekPendingSeed();
    if (!pending || !pending.seed) return;
    seedInFlight = true;
    try {
      if (pending.model) await applyModel(pending.model);
      const ok = await fillComposer(pending.seed);
      if (!ok) return; // keep the seed so a retry/reload can still fill it
      await CLHStore.clearPendingSeed(); // clear only once the composer actually has it
    } finally {
      seedInFlight = false;
    }
  }

  /* ---------- lifecycle ---------- */

  let renderTimer = null;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      try {
        ensureSidebar();
        renderRecentsRows();
        decorateSelectMode();
      } catch (_) {}
    }, 250);
  }

  let lastPath = location.pathname;
  function onRoute() {
    // Only rebuild the sidebar on an actual navigation. replaceState also fires on
    // query-only changes (e.g. ?search=…) — wiping entries there just causes flicker.
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      removeSidebarInjected();
    }
    scheduleRender();
    handlePendingSeed();
  }

  function hookRouting() {
    const p = history.pushState;
    history.pushState = function () {
      const r = p.apply(this, arguments);
      setTimeout(onRoute, 60);
      return r;
    };
    const rp = history.replaceState;
    history.replaceState = function () {
      const r = rp.apply(this, arguments);
      setTimeout(onRoute, 60);
      return r;
    };
    window.addEventListener("popstate", onRoute);
  }

  function hookSearch() {
    document.addEventListener(
      "input",
      (e) => {
        const t = e.target;
        if (t && t.matches && t.matches('input[placeholder*="Search" i], input[type="search"]')) {
          ensureSearchIndex().then(() => scheduleRender());
        }
      },
      true
    );
  }

  async function init() {
    await loadState();
    hookRouting();
    hookSearch();
    hookSelectActions();
    observer = new MutationObserver(() => scheduleRender());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "local") return;
      if (changes["clh:settings"] || changes["clh:index"] || changes["clh:searchIndex"] || changes["clh:consumed"]) {
        await loadState();
        if (changes["clh:searchIndex"] || changes["clh:index"]) searchMap = null; // invalidate stale content-search cache
        const tb = findRecentsTbody();
        if (tb) tb.__clhSig = null; // force a re-render past the idempotency guard
        removeSidebarInjected();
        ensureSidebar();
        renderRecentsRows();
      }
    });
    if (location.pathname === "/recents") await ensureSearchIndex();
    scheduleRender();
    handlePendingSeed();
    // native dates enable date-interleaving; re-render once they arrive
    getNativeDates().then((m) => {
      if (m && Object.keys(m).length) {
        removeSidebarInjected();
        scheduleRender();
      }
    });
  }

  init();
})();