# PwdPal

**A password manager with no vault.** PwdPal turns three things you control — a
secret phrase, a pattern you draw, and the website's name — into a strong, unique
password for every site. The same three inputs always produce the same password,
so you can regenerate it on any device, anytime, with nothing stored and nothing
to sync.

Everything happens in your browser. No account, no server, no database — your
inputs never leave your device.

→ Try it at **[pwdpal.com](https://pwdpal.com)**

## How it works

PwdPal is a **deterministic** password generator. Instead of storing your
passwords in an encrypted vault, it *derives* them on demand:

```
  your secret phrase ┐
  your drawn pattern ├──►  PBKDF2-SHA256 (600,000 iterations)  ──►  site password
  the site's domain  ┘
```

- Your **secret phrase** and **pattern** are your master key — known only to you,
  never transmitted.
- The **domain** makes every site's password different, even though your phrase
  and pattern stay the same.
- Because each password is *computed, not stored*, there's no vault to breach,
  leak, or sync across devices. You reproduce a password by re-entering the same
  inputs.

The cryptography is standard and runs entirely via the browser's built-in
[Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API):
PBKDF2 with SHA-256 at 600,000 iterations (in line with current OWASP guidance),
followed by a deterministic mapping shaped to satisfy common site password rules.

## Why you might want this

- **Nothing to sync, nothing to breach.** There's no encrypted vault on a server
  to be stolen or held hostage.
- **Works anywhere, from memory.** Any browser, any device — re-enter your phrase
  and pattern and your passwords are back. No export/import, no account recovery.
- **Auditable.** Plain, unminified HTML/CSS/JavaScript, zero dependencies, no
  build step — what's in this repo is what runs in your browser. Read every line.
- **No tracking.** The web app runs no analytics script and sets no cookies. The
  browser extension sends nothing at all.

## The honest tradeoffs

Deterministic generation isn't free of downsides, and we'd rather you know them up
front:

- **Your inputs are everything.** Forget your phrase or pattern and there is no
  "reset password" — the passwords were never stored, so they can't be recovered.
  Treat them like the master key they are.
- **Rotation is manual.** If a site is breached and you need a new password, you
  generate a variant for that site (e.g. a "#2") and update it there. There's no
  central re-key that silently rotates one stored secret — you change it per site.
- **Some sites won't cooperate.** A few sites have unusual or restrictive password
  rules that a generated password can clash with.
- **It won't import your existing passwords**, and it isn't a full identity
  suite — no breach monitoring, no shared vaults, no 2FA storage.

If those are dealbreakers, a traditional vault manager (Bitwarden, 1Password) may
suit you better — and that's a perfectly good choice. PwdPal is for people who
want strong, unique passwords with no vault to manage.

## What's in this repo

- `index.html`, `js/`, `css/`, `sw.js` — the web app (also installable as a PWA)
- `how-it-works.html`, `privacy.html` — the in-product explainer and privacy page

The PwdPal browser extension (same core generator, plus autofill) is distributed
via the Chrome Web Store and isn't included in this repository.

## Running it locally

PwdPal has no build step. Serve the folder with any static file server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(A service worker powers offline/PWA use, so it needs to be *served* rather than
opened as a `file://` URL.)

## Reporting a security issue

Please email **security@pwdpal.com** (see [`/.well-known/security.txt`](.well-known/security.txt))
rather than opening a public issue, so it can be handled responsibly.

## License

See [LICENSE](LICENSE).
