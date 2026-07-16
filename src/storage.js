// SPDX-License-Identifier: MIT
// Copyright (c) 2026 B-Yond

/*
 * Shared storage layer for Attic for Claude.
 * Loaded both as the first content script and by the options page.
 * Defines a global `CLHStore`.
 *
 * Storage keys (chrome.storage.local):
 *   clh:index        -> [{uuid, name, created_at, updated_at, count, hasImages}]  (light, for sidebar/recents)
 *   clh:searchIndex  -> [{uuid, name, t}]  (t = lowercased title+content blob, capped; lazy-loaded for local search)
 *   clh:conv:<uuid>  -> {uuid, name, created_at, updated_at, summary, messages:[{sender,text,created_at,attachments?,files?}]}
 *   clh:settings     -> {enabled, dateFrom, dateTo, includeAttachments, continueModel, sidebarLimit}
 *   clh:consumed     -> {uuid: {at, newUrl?}}   (continued threads, hidden from lists)
 *   clh:pendingSeed  -> {seed, model}   (handed to the /new page)
 */
var CLHStore = (function () {
  const ROOT = "00000000-0000-4000-8000-000000000000";
  const SEARCH_CAP = 1800; // chars of searchable text kept per conversation

  const K = {
    index: "clh:index",
    searchIndex: "clh:searchIndex",
    settings: "clh:settings",
    consumed: "clh:consumed",
    pendingSeed: "clh:pendingSeed",
    conv: (uuid) => "clh:conv:" + uuid,
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    dateFrom: null, // "YYYY-MM-DD" or null
    dateTo: null,
    includeAttachments: true, // include text-attachment content in the continuation seed
    continueModel: null, // e.g. "Opus 4.8" — best-effort model to pick on continue; null = leave default
    continueThinking: null, // reserved; null = leave default
    sidebarLimit: 30, // max local chats shown in the sidebar (0 = all); the rest live on the All-chats page
  };

  async function get(key, def) {
    const o = await chrome.storage.local.get(key);
    return o[key] !== undefined ? o[key] : def;
  }
  function set(obj) {
    return chrome.storage.local.set(obj);
  }

  const IMG_RE = /\.(png|jpe?g|gif|webp|svg|heic|bmp|tiff?)$/i;
  const isImageName = (n) => !!(n && IMG_RE.test(n));

  // Friendly verb per tool so a tool_use block renders as a readable pill instead of
  // claude.ai's "This block is not supported…" export placeholder.
  const TOOL_LABELS = {
    web_search: "Searched the web",
    web_fetch: "Read a page",
    launch_extended_search_task: "Ran deep research",
    artifacts: "Wrote an artifact",
    repl: "Ran code",
    bash_tool: "Ran a command",
    str_replace: "Edited a file",
    create_file: "Created a file",
    view: "Viewed a file",
    present_files: "Shared files",
  };
  function toolLabel(c) {
    const base = TOOL_LABELS[c.name] || "Used " + (c.name || "a tool").replace(/[:_]/g, " ");
    const inp = c.input || {};
    const hint = inp.query || inp.url || inp.title || inp.command || inp.path || "";
    return hint ? base + " · " + String(hint).slice(0, 120) : base;
  }

  // Build a structured block list from a message. Rich blocks (thinking/tool_use) are
  // preserved so the viewer can render them natively; `text` is the clean concatenation
  // of the text blocks (used for search + continuation seeds).
  function simplify(m) {
    const out = { sender: m.sender, created_at: m.created_at };
    const content = Array.isArray(m.content) ? m.content : null;
    if (content && content.length) {
      const blocks = [];
      const textParts = [];
      for (const c of content) {
        if (!c) continue;
        if (c.type === "text" && c.text) {
          blocks.push({ t: "text", v: c.text });
          textParts.push(c.text);
        } else if (c.type === "thinking" && c.thinking && !c.hidden && !c.thinking_hidden) {
          blocks.push({ t: "think", v: c.thinking });
        } else if (c.type === "tool_use") {
          blocks.push({ t: "tool", v: toolLabel(c) });
        }
        // tool_result / token_budget: intentionally omitted (noise)
      }
      if (blocks.length) out.blocks = blocks;
      out.text = textParts.join("\n\n").trim() || (m.text && !/This block is not supported/.test(m.text) ? m.text : "");
    } else {
      out.text = m.text || "";
    }
    const atts = (m.attachments || [])
      .filter(Boolean)
      .map((a) => ({ name: a.file_name || "file", type: a.file_type || "", content: a.extracted_content || "" }));
    if (atts.length) out.attachments = atts;
    const files = (m.files || [])
      .filter(Boolean)
      .map((f) => ({ name: f.file_name || "file", uuid: f.file_uuid || null, image: isImageName(f.file_name) }));
    if (files.length) out.files = files;
    return out;
  }

  // Reconstruct the active thread. The export has no "current leaf" pointer, so we
  // take the most recently created message as the leaf and walk parent pointers up to
  // the root — this yields the branch the conversation actually ended on (picking the
  // newest child at each fork can diverge onto an abandoned edit branch).
  function orderMessages(chatMessages) {
    if (!chatMessages || !chatMessages.length) return [];
    const byUuid = new Map();
    for (const m of chatMessages) byUuid.set(m.uuid, m);
    let leaf = chatMessages[0];
    for (const m of chatMessages) {
      if (new Date(m.created_at || 0) > new Date(leaf.created_at || 0)) leaf = m;
    }
    const path = [];
    const seen = new Set();
    let cur = leaf;
    while (cur && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      path.push(cur);
      const parent = cur.parent_message_uuid;
      cur = parent && parent !== ROOT ? byUuid.get(parent) : null;
    }
    path.reverse();
    // fallback if the chain was broken and we recovered fewer than half the messages
    if (path.length * 2 < chatMessages.length) {
      return chatMessages
        .slice()
        .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
        .map(simplify);
    }
    return path.map(simplify);
  }

  function buildSearchBlob(name, messages) {
    let s = name || "";
    for (const m of messages) {
      s += " " + (m.text || "");
      if (m.attachments) s += " " + m.attachments.map((a) => a.name + " " + (a.content || "")).join(" ");
      if (m.files) s += " " + m.files.map((f) => f.name).join(" ");
    }
    return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, SEARCH_CAP);
  }

  return {
    K,
    DEFAULT_SETTINGS,

    async getSettings() {
      return Object.assign({}, DEFAULT_SETTINGS, await get(K.settings, {}));
    },
    async setSettings(s) {
      await set({ [K.settings]: s });
    },

    async getIndex() {
      return await get(K.index, []);
    },
    async getSearchIndex() {
      return await get(K.searchIndex, []);
    },
    async getConv(uuid) {
      return await get(K.conv(uuid), null);
    },

    async getConsumed() {
      return await get(K.consumed, {});
    },
    async setConsumed(c) {
      await set({ [K.consumed]: c });
    },
    async markConsumed(uuid, info) {
      const c = await this.getConsumed();
      c[uuid] = Object.assign({ at: Date.now() }, info || {});
      await this.setConsumed(c);
    },
    async resetConsumed() {
      await set({ [K.consumed]: {} });
    },

    async setPendingSeed(payload) {
      await set({ [K.pendingSeed]: payload });
    },
    async peekPendingSeed() {
      return await get(K.pendingSeed, null);
    },
    async clearPendingSeed() {
      await chrome.storage.local.remove(K.pendingSeed);
    },

    // Permanently remove one conversation (record + index + search + consumed).
    async deleteConversation(uuid) {
      await chrome.storage.local.remove(K.conv(uuid));
      const index = (await get(K.index, [])).filter((e) => e.uuid !== uuid);
      const searchIndex = (await get(K.searchIndex, [])).filter((e) => e.uuid !== uuid);
      const consumed = await get(K.consumed, {});
      delete consumed[uuid];
      await set({ [K.index]: index, [K.searchIndex]: searchIndex, [K.consumed]: consumed });
    },

    // Import a parsed conversations.json (array of conversation objects).
    async importData(conversations, onProgress) {
      if (!Array.isArray(conversations)) throw new Error("Expected an array of conversations");
      const index = [];
      const searchIndex = [];
      let batch = {};
      let n = 0;
      const flush = async () => {
        if (Object.keys(batch).length) {
          await set(batch);
          batch = {};
        }
      };
      for (const c of conversations) {
        if (!c || !c.uuid) continue;
        const messages = orderMessages(c.chat_messages || []);
        const hasImages = messages.some((m) => (m.files || []).some((f) => f.image));
        batch[K.conv(c.uuid)] = {
          uuid: c.uuid,
          name: c.name || "",
          created_at: c.created_at,
          updated_at: c.updated_at,
          summary: c.summary || "",
          messages,
        };
        index.push({
          uuid: c.uuid,
          name: c.name || "",
          created_at: c.created_at,
          updated_at: c.updated_at,
          count: messages.length,
          hasImages,
        });
        searchIndex.push({ uuid: c.uuid, name: c.name || "", t: buildSearchBlob(c.name, messages) });
        n++;
        if (Object.keys(batch).length >= 40) {
          await flush();
          if (onProgress) onProgress(n);
        }
      }
      await flush();
      // Merge with any previously-imported data (update by uuid, keep the rest) so a
      // partial re-import doesn't wipe conversations that aren't in this file.
      const newUuids = new Set(index.map((e) => e.uuid));
      const mergedIndex = index.concat((await get(K.index, [])).filter((e) => !newUuids.has(e.uuid)));
      const mergedSearch = searchIndex.concat((await get(K.searchIndex, [])).filter((e) => !newUuids.has(e.uuid)));
      mergedIndex.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
      await set({ [K.index]: mergedIndex, [K.searchIndex]: mergedSearch });
      if (onProgress) onProgress(n);
      return mergedIndex.length;
    },

    async clearAll() {
      const all = await chrome.storage.local.get(null);
      const keys = Object.keys(all).filter((k) => k.startsWith("clh:"));
      if (keys.length) await chrome.storage.local.remove(keys);
    },
  };
})();

if (typeof window !== "undefined") window.CLHStore = CLHStore;