# Website verification

Install local browser dependencies with `npm ci`. Use installed Microsoft
Edge by setting `$env:PW_CHANNEL='msedge'` in PowerShell, or install the test
browser with `npx playwright install chromium`.

Run `node build.js` then `npm test`. The browser suite serves `docs/` as
static files and uses fresh sessions with no saved password. It checks:

- Public pages and simulation startup without authentication.
- Crawlable HTML without JavaScript, canonical URLs, robots and sitemap.
- Navigation, contact deep links and careers role selection.
- Phone, tablet and desktop layouts, keyboard controls and form labels.
- Form validation and email-copy fallbacks (no email is sent).
- Public MP4 playback, on-demand loading, independent controls, reduced
  motion, offscreen/manual pause, and retry after a failed media request.

Run `npm run test:navigation` for simulation regressions. The suite runs
all six scenarios for 660 simulated seconds each. It checks hulls against
contacts and banks, progress past the bridge, stopping at a blocked bridge,
and reset behaviour. These are demonstration simulation checks.

Optional simulation environment variables: SIM_ROOT (default
`docs/simulation`), SIM_SCENARIO, SIM_DURATION, SIM_STEP (default 0.1),
and SIM_VERBOSE. Ground truth is used only in test assertions.

The public-domain assertions target https://cornu.ai/. If changing the main
address, update those expectations alongside the build configuration.
The older root `simulation/` directory is an archived prototype.
