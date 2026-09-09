# Cornu — private preview hosting

Publishes the Cornu site to GitHub Pages behind a password.

**Password:** `cornu2026!`

---

## First, what this actually protects

GitHub Pages is a static file host. There is no server, so there is nothing that
can check a password before deciding what to send you. Any "enter a password"
overlay on a static site can be skipped by opening the source — unless the page
content itself is encrypted.

So that is what this does. Each published page — `docs/index.html` and
`docs/products/index.html` — contains:

- the unlock screen, and
- the entire site encrypted with **AES-256-GCM**, using a key derived from your
  password with **PBKDF2-SHA256, 310,000 rounds** and a random salt.

The password is not in the file. Nothing readable is in the file. Open the
published page and "View source" and you get a login screen and a wall of
base64. Decryption happens in the visitor's browser after they type the
password correctly.

**What it is good for:** keeping a pre-launch site away from casual visitors,
search engines, competitors browsing around, and anyone you have not given the
password to. For sharing a work-in-progress with investors, a design partner or
a pilot customer, this is the right tool.

**What it is not:** real access control. Be clear-eyed about three things.

1. **Anyone with the password can pass it on.** There are no accounts, no
   per-person links, no way to see who opened it.
2. **The ciphertext is downloadable**, so an attacker can guess passwords
   offline, as fast as their hardware allows, with no rate limit.
   `cornu2026!` follows an extremely guessable pattern — a word, a year, a
   punctuation mark. The 310,000 PBKDF2 rounds make each guess cost real time,
   which stops casual attempts, but it will not stop somebody who specifically
   targets you. If what is behind the gate ever becomes genuinely sensitive,
   change to a long random passphrase (see below) — four unrelated words is
   worth vastly more than adding symbols to one word.
3. **Do not put anything confidential behind it.** A marketing site is fine.
   Financial models, customer names, unfiled IP, anything under NDA — no.

If you need actual authentication, jump to *Stronger options* at the bottom.

---

## Publish it

You need [git](https://git-scm.com) and a GitHub account.

**1. Create the repository.** On GitHub, click New repository, name it
`cornu-site`, leave it empty (no README), and create it.

On a free account, GitHub Pages only works from a **public** repository. That is
fine — the only thing being published is the encrypted file. The `.gitignore`
in this folder keeps `source/` out of the repo, which is what makes that safe.
Never remove that line.

**2. Push this folder.** From inside it:

```bash
git init
git add .
git commit -m "Cornu site — encrypted preview"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/cornu-site.git
git push -u origin main
```

Before pushing, run `git status` once and confirm `source/` does **not** appear.

**3. Turn on Pages.** In the repository: **Settings → Pages**. Under
"Build and deployment", set Source to **Deploy from a branch**, branch **main**,
folder **/docs**, and Save.

**4. Wait a minute**, then open:

```
https://YOUR-USERNAME.github.io/cornu-site/
```

You should get the unlock screen. Type `cornu2026!`.

The URL is ugly but real and shareable. To use `cornu.ai` instead, add a
`CNAME` file containing your domain to `docs/`, point a DNS CNAME record at
`YOUR-USERNAME.github.io`, and set the custom domain in Settings → Pages.

---

## Change the password

```bash
CORNU_PASSWORD='four unrelated words here' node build.js
git add docs && git commit -m "Rotate password" && git push
```

The old password stops working the moment the new file goes live — the site is
re-encrypted, not just re-checked. This is also how you revoke access after
sharing with someone: rotate and reshare.

On Windows PowerShell:

```powershell
$env:CORNU_PASSWORD='four unrelated words here'; node build.js
```

Note the password is echoed in your terminal when the build runs, and lands in
your shell history. If that matters, clear the history line afterwards.

---

## Edit the site, then republish

The real site lives in `source/`. Edit it exactly as before — team members,
copy, colours, everything (see `source/README.md`). Preview your changes by
opening `source/index.html` or `source/products/index.html` directly in a
browser; no password there.

There are two pages. `source/index.html` is the home page and
`source/products/index.html` is the Bridge Watch product page, published at
`/products/`. Both share `source/assets/`, and both are encrypted with the
same password, so a visitor who unlocks one can move between them without
being asked again in that tab. To add a third page, create it under
`source/` and add a line to the `pages` array near the bottom of
`build.js`; asset paths are resolved relative to the page, so a page one
directory down refers to `../assets/...`.

When it looks right:

```bash
node build.js
git add docs
git commit -m "Update team section"
git push
```

Pages redeploys in under a minute. Hard-refresh (Cmd/Ctrl + Shift + R) to get
past the browser cache.

`build.js` inlines the CSS, JS and favicon into one document, checks that the
script still compiles, encrypts the result and writes `docs/index.html`. It will
refuse to build rather than ship something broken.

---

## Notes on behaviour

- After a correct password, the site is kept unlocked for that browser tab via
  `sessionStorage`, so refreshing and following links does not re-prompt.
  Closing the tab locks it again.
- `robots.txt` disallows everything and the gate carries `noindex, nofollow`,
  so it stays out of search results.
- Decryption uses the Web Crypto API, which browsers only expose over
  `https://` or `file://` — GitHub Pages is https, so this is fine. On very old
  browsers the gate says so rather than failing silently.
- The gate loads fonts from Google Fonts. If you would rather leak nothing at
  all to a third party before unlock, delete the two `<link>` font tags from the
  `gate()` template in `build.js`; the unlock screen will fall back to a system
  monospace face.

---

## Stronger options, if you outgrow this

**Cloudflare Access** — free for up to 50 users, and it is real authentication:
Cloudflare sits in front of the site and nobody reaches the files without
passing. You get per-person access, an audit log, and instant revocation. It
needs your domain on Cloudflare (free plan) and works with any static host.
This is what I would move to once you are sharing with named people rather than
a group.

**Vercel or Netlify password protection** — one toggle, server-side, but on
their paid tiers (Vercel Pro, Netlify Pro).

**GitHub Pages from a private repo** — available on GitHub Pro and Team. Worth
knowing: this hides the *source*, not the site. The published page is still
public. It solves a different problem than the one you asked about.

---

## Files

```
.
├── build.js               inline → encrypt → write each page into docs/
├── docs/                  what gets published (commit this)
│   ├── index.html         unlock screen + encrypted home page
│   ├── products/
│   │   └── index.html     unlock screen + encrypted Bridge Watch page
│   ├── simulation/        the interactive simulation, not encrypted
│   ├── robots.txt
│   └── .nojekyll
├── source/                the real site, unencrypted (never commit)
│   ├── index.html         home
│   ├── products/index.html  Bridge Watch
│   ├── simulation/        simulation sources
│   └── assets/            css, js, images shared by every page
└── .gitignore             keeps source/ out of the repo
```

Note that `docs/simulation/` is published in the clear — it is copied, not
encrypted, because it is a standalone application rather than a page of the
site. Keep that in mind before putting anything in it you would not want
read without the password.
