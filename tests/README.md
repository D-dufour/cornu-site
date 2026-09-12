# Website verification

Install browser test dependencies with `npm ci` and `npx playwright install chromium`.
Run `npm run test:website` to check the encrypted `docs/` output: decryption,
scene rendering, pause/resume, responsive layouts, keyboard navigation,
reduced motion, portraits, local links and contact validation. The test serves
only `docs/` on an ephemeral loopback port and closes the server afterward.

For an installed Edge browser on Windows, run
`$env:PW_CHANNEL='msedge'; npm run test:website`. Set `CORNU_PASSWORD` when
testing a build made with a custom password. `npm test` runs both the website
checks and the simulation regressions below.

Run the navigation regressions against the published simulation:

    node --test tests/navigation.test.cjs

The suite runs all six scenarios for 660 simulated seconds each. It checks
actual hull polygons against every ground-truth contact and both banks,
requires progress past the bridge, verifies stopping at an impassable bridge,
and checks that looping/reset clears the previous model and commands.
Ground truth is used by the test assertions only, never by route planning.

Optional environment variables: SIM_ROOT (defaults to docs/simulation),
SIM_SCENARIO, SIM_DURATION, SIM_STEP (defaults to 0.1 seconds), SIM_VERBOSE.
For normal 60 FPS timing use SIM_STEP=0.016666666666666666; for 4x use
SIM_STEP=0.06666666666666667.

The local authoring tree is ignored by Git. Run node build.js after changing
source/, then test the docs/ output before publishing. The older simulation/
directory is an archived prototype; docs/simulation/ is the deployed app.
