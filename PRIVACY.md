# Privacy Policy for Attic for Claude

_Last updated: July 2026_

A hosted web version of this policy is available here:
<https://claude.ai/code/artifact/6d65de9f-04d6-4f4b-b66b-f02fd8932174>

Attic for Claude is a browser extension that displays your own exported Claude
conversation history inside claude.ai. Your privacy is simple to describe because
the extension is built to keep everything on your device.

## What data the extension handles

- **Your imported `conversations.json`** — the export you choose to load. It is parsed
  and stored **locally** using the browser's `chrome.storage.local` API (with the
  `unlimitedStorage` permission so large archives are not truncated).
- **Extension settings** — your display preferences (enabled, date range, selected
  continuation model, etc.), also stored locally.

## What the extension does NOT do

- It does **not** transmit your conversations, settings, or any other data to the
  developer or to any third-party server. There is no analytics, no telemetry, and no
  external network request initiated by this extension to send your data anywhere.
- It does **not** sell or share your data.
- It reads the claude.ai page you are already using (to place your local chats in the
  sidebar and to seed a new chat when you continue one). It does not exfiltrate page
  content.

## Where your data lives

All imported data and settings live in your browser's local extension storage on your
own computer. Uninstalling the extension, or using **Delete all local data** on the
options page, removes it.

## Network access

The only network requests the extension makes are **same-origin calls to claude.ai's
own API** (using your existing logged-in session) to read the list of your native
conversation dates — this is used solely to sort your imported chats in the correct
date order alongside your live chats. No data leaves claude.ai as a result.

## Contact

This is an open-source project. Questions or concerns can be raised via the project's
issue tracker.

_Not affiliated with, endorsed by, or sponsored by Anthropic. “Claude” is a trademark
of Anthropic._
