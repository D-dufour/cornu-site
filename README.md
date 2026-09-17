# Cornu public website

This site is a static website prepared for https://cornu.ai on Yourhosting.
There is no password gate or server-side runtime. Pages are ordinary HTML,
CSS and browser JavaScript; videos are standard MP4 files.

Read [YOURHOSTING-SETUP.md](YOURHOSTING-SETUP.md) for upload, domain, HTTPS
and email setup instructions. The upload archive is
`release/cornu-yourhosting.zip`; only its contents belong on the server.

## Editing and building

Edit `source/index.html`, `source/products/index.html`,
`source/careers/index.html`, and shared assets in `source/assets/`.
The current simulation is authored in `source/simulation/`.
The root `index.html`, `assets/` and `simulation/` are older prototypes;
do not upload them.

Run `node build.js` locally to generate `docs/`. The build bundles marketing
page assets, copies the simulation and MP4 videos, and generates public
robots metadata, canonical links and a sitemap. The default main address is
https://cornu.ai/; set `CORNU_SITE_URL` to override it before building.

On Windows, `powershell -NoProfile -ExecutionPolicy Bypass -File
.\package-yourhosting.ps1` builds the site and creates the upload ZIP.
The source folder remains ignored by Git, so retain a local backup of it.
Published `docs/` files are now intentionally public and readable.

## Verification

Run `npm ci` to install local test dependencies, then `npm test` after a
build. For installed Microsoft Edge in PowerShell set
`$env:PW_CHANNEL='msedge'`; otherwise install the test browser with
`npx playwright install chromium`. See [tests/README.md](tests/README.md).

## Forms

Contact and careers forms validate details and prepare an email draft, with
copy and selectable-text fallbacks. The visitor sends the email. There is
no form backend or CV storage. Configure and verify hello@cornu.ai and
careers@cornu.ai before accepting enquiries or applications.
