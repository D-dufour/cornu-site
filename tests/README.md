# Website verification

Install browser test dependencies with `npm ci`, then install Chromium with
`npx playwright install chromium`. After building, run `npm test` to check
career links, role selection, application validation and copy fallback, internal
links, responsive layouts (320-1440 px, including landscape), keyboard menu
behaviour, and simulation controls on a phone viewport. The tests use a local
server and never send an application email.

To use an installed Microsoft Edge browser in PowerShell:

    $env:PW_CHANNEL='msedge'
    npm test

The default preview password is used unless `CORNU_PASSWORD` is set. The suite
checks the encrypted `docs/` output, so run `npm run build` after source changes.

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
