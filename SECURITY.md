# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub's private vulnerability reporting instead: open the **Security** tab of this
repository and click **Report a vulnerability**. That opens a private channel with the
maintainers. We will acknowledge your report, work on a fix, and credit you if you would like.

## What to look at

Attic for Claude runs entirely in the browser and stores all data locally. The areas that
matter most for security are:

- The Markdown renderer in `src/markdown.js`. It must HTML-escape all stored content and
  scheme-validate every URL, so a malicious conversation cannot inject a script. Never add a
  raw-HTML passthrough.
- The content script in `src/content.js`, which injects into claude.ai pages.

## Supported versions

The latest release on the `main` branch is the supported version.
