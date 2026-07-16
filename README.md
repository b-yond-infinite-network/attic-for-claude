<div align="center">
  <img src="icons/icon-128.png" width="88" height="88" alt="Attic for Claude" />
  <h1>Attic for Claude</h1>
  <p><em>Bring your exported Claude conversation history back into claude.ai. Browse it, and continue any chat.</em></p>
  <p>
    <a href="https://chromewebstore.google.com/detail/attic-for-claude/nbeehnmaldgfkdpaonolbpjolhecofdc"><strong>Chrome Web Store</strong></a>
    &nbsp;·&nbsp;
    <a href="MANUAL.md"><strong>User Guide</strong></a>
  </p>
</div>

---

Claude.ai lets you **export** your conversation history but not import it back. **Attic
for Claude** is a Chrome extension (Manifest V3) that loads your exported
`conversations.json` and surfaces those past chats **inside claude.ai itself** —
interleaved by date in the sidebar and the All-chats page, styled to match the native
UI, searchable, and readable in a faithful viewer. You can **continue** any archived
chat: it opens a new conversation seeded with the prior thread as context.

Everything stays **on your device**. Nothing is uploaded anywhere.

> **Not affiliated with, endorsed by, or sponsored by Anthropic.** “Claude” is a
> trademark of Anthropic. This is an independent tool that works with the claude.ai web
> app.

## Why this exists

claude.ai has no supported way to re-import an exported archive, and its backend has no
endpoint that writes back your original assistant messages (the only message-writing
endpoint *regenerates* responses). So a true 1:1 re-import into your live history isn't
possible. Attic takes the honest approach: your archive is a **local, read-only overlay**
that looks and feels native, and "continue" uses the supported new-chat + context-seed
path.

## Features

- 🗂 **Native-feeling archive** — your past chats appear in the claude.ai sidebar and the
  All-chats table, **interleaved by date** with your live chats, marked with a small
  coral dot.
- 🔎 **Local search** — claude's search is server-side and can't see your archive, so
  Attic injects your own matching chats into the results as you type.
- 📖 **Faithful viewer** — click a chat to read it in an overlay that mirrors claude.ai:
  Anthropic's own fonts, a full **Markdown renderer** (headings, lists, tables, code
  blocks with copy, blockquotes, links), and the same light/dark theming.
- ↩️ **Continue a chat** — type a message and Attic opens a new claude.ai chat pre-seeded
  with the prior conversation (and any text-file attachment content) as context. Once
  continued, that archived entry drops out of the list.
- 🎛 **Controls** — enable/disable, filter by date range, choose a model for
  continuations, restore continued chats, or wipe all local data.

## Install

### From the Chrome Web Store

Open the listing and click **Add to Chrome**:
[Attic for Claude on the Chrome Web Store](https://chromewebstore.google.com/detail/attic-for-claude/nbeehnmaldgfkdpaonolbpjolhecofdc).

New here? The [User Guide](MANUAL.md) walks through every feature with screenshots.

### Load unpacked (development)

1. Clone or download this repo.
2. Go to `chrome://extensions` and enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Click the Attic toolbar icon → the options page opens.
5. Export your data from claude.ai (**Settings → Privacy → Export data**), then import the
   `conversations.json` from the ZIP.
6. Open/reload **claude.ai** — your archive appears in the sidebar.

## How it works

| Piece | Mechanism |
| --- | --- |
| Storage | `chrome.storage.local` + `unlimitedStorage`, one record per conversation, plus a light index and search blob |
| Placement | Injects entries into the recents `<ul>` and the `/recents` table; a `MutationObserver` re-injects across React re-renders and route changes |
| Date order | Reads your native conversation dates from claude.ai's own API (your session) to interleave correctly |
| Viewer | Own overlay themed with claude's CSS variables + Anthropic font names (referenced, never bundled) |
| Markdown | `src/markdown.js` — a small, dependency-free, HTML-escaping renderer |
| Continue | Stores a seed, opens `/new`, pastes it into the composer |

## Privacy & security

- All data is stored locally and is never sent to the developer or any third party. The
  only network requests are same-origin calls to claude.ai's own API (via your existing
  session) to read your conversation dates for correct ordering. See [`PRIVACY.md`](PRIVACY.md),
  also available as a [hosted policy](https://claude.ai/code/artifact/6d65de9f-04d6-4f4b-b66b-f02fd8932174).
- The Markdown renderer HTML-escapes all stored content and scheme-validates every URL,
  so a malicious conversation can't inject script. **Do not add raw-HTML passthrough.**

## Development

No build step — plain JS/CSS/HTML loaded directly by the browser.

```
attic-for-claude/
├── manifest.json          # MV3 manifest
├── icons/                 # icon.svg + exported PNGs (16/32/48/128)
├── src/
│   ├── storage.js         # chrome.storage layer (import, index, search, settings)
│   ├── markdown.js        # dependency-free, XSS-hardened Markdown renderer
│   ├── content.js         # sidebar/recents injection, viewer, continue, interleave
│   ├── content.css        # native-matching styles
│   ├── background.js      # toolbar click → options
│   └── options.html/.js   # import & settings page
├── MANUAL.md              # user guide with screenshots
├── docs/images/           # screenshots used by the user guide
├── PRIVACY.md
└── LICENSE
```

Handy checks:

```bash
# syntax-check every script
for f in src/*.js; do node --check "$f"; done

# regenerate icons from the SVG (needs librsvg: `brew install librsvg`)
for s in 16 32 48 128; do rsvg-convert -w $s -h $s icons/icon.svg -o icons/icon-$s.png; done
```

## Limitations

- **Not a 1:1 re-import.** Continued chats are new conversations seeded with context, not
  clones of the originals with their original assistant turns.
- **Images aren't in the export.** Claude's data export contains image *references*, not
  the image bytes, so archived images can't be re-attached; the viewer marks them as
  "not in export."
- **Model / thinking mode** aren't recorded in the export, so they can't be restored — you
  can only *choose* a model for continuations.
- **Selector fragility.** If claude.ai changes its DOM, the selectors in `src/content.js`
  may need updating.

## License

[MIT](LICENSE) © 2026 B-Yond.
