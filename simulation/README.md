# CORNU — Maritime Spatial Intelligence System

A real-time software-in-the-loop prototype of a semantic world model for
assisted and autonomous navigation of large inland-waterway vessels.

A 100 m cargo vessel travels a curving 1.75 km channel. Thirteen simulated
sensors observe the environment badly — with noise, dropouts, occlusion,
latency and classification confusion — and CORNU builds, from those
observations alone, a persistent understanding of what is around the vessel,
what it is, where it is going and what it threatens.

> Sensors perceive observations. CORNU maintains an understanding of the
> physical world.

---

## Run it

```
open index.html
```

No build step, no dependencies, no server. It runs from `file://` in any
current browser. Fonts load from Google Fonts, so first paint of the intended
typography needs a connection; everything else is local.

Optionally: `python3 -m http.server 8000`

---

## What to look at first

1. **Press "World model"** in the header, then tick **Occupancy grid** and
   **Raw observations** in the Layers panel. This is the point of the whole
   prototype: the reconstructed channel, free space carved out by sensor
   rays, the corridor CORNU considers navigable, and the raw pre-fusion
   detections scattered around each object before they become one entity.

2. **Switch between World model → Blended → Ground truth.** Ground truth
   draws the real objects in grey over CORNU's estimate. The gap between the
   grey box and the coloured box is the error, visible directly.

3. **Run the Bridge scenario.** Watch the clearance estimate converge as the
   vessel closes: roughly 9.17 m at 600 m out, 9.30 m at 380 m, against a
   true 9.4 m, with confidence climbing 85% → 100%.

4. **Run Collision.** A vessel drifts into your lane; risk escalates
   low → high → critical and a conflict marker appears in 3D at the predicted
   intersection point.

5. **Click any tracked object** for the inspector: state, covariance,
   contributing sensors, observation count, track age, CPA/TCPA.

6. **Run Occlusion.** One vessel hides behind another. Its track does not
   disappear — it goes `COASTING`, keeps propagating on dead reckoning, and
   loses confidence until it is either re-observed or dropped.

---

## Scenarios

| | |
|---|---|
| **Normal** | Ordinary traffic, no hazards. Should be alert-free. |
| **Bridge** | Starts 650 m south of the bridge; clearance and opening estimates converge. |
| **Collision** | Oncoming vessel crosses into your lane. |
| **Obstacle** | Low-signature floating debris in the lane; evidence accumulates from `UNKNOWN` upward. |
| **Sensor fail** | Bow camera goes offline, telephoto degrades; tracking continues on radar and LiDAR. |
| **Occlusion** | A vessel is hidden behind another; semantic memory carries it. |

Controls: play/pause, 0.25×–4×, reset. Drag to orbit, wheel to zoom.

---

## Display density

**Clean** (default) is what an operator should see: solid hulls, one path
ribbon, the navigable corridor, and names only for genuine hazards, the
selected object and anything within 190 m. Everything fades with distance
instead of piling up at the vanishing point.

**Engineering** restores the diagnostics: raw pre-fusion observations,
covariance ellipses, track history, range arcs and the full per-object
readout.

The restraint is deliberate. Colour carries meaning only where there is
meaning to carry — ordinary traffic is neutral grey, and amber or red is
earned by risk or by a track that has gone to dead reckoning. A scene where
everything is annotated is a scene where nothing stands out.

---

## Architecture

See **ARCHITECTURE.md** for the full treatment. In short:

```
GROUND TRUTH  →  SENSORS  →  OBSERVATIONS  →  ASSOCIATION  →  TRACKING
   →  FUSION  →  WORLD MODEL  →  PREDICTION  →  RISK  →  VISUALISATION
```

The separation is real, not decorative. `10-world.js` owns ground truth and
`20-sensors.js` is the only module allowed to read it; everything downstream
sees `SensorObservation` objects. The renderer draws from the world model,
with one explicit ground-truth overlay so you can compare. Grep for
`world.entities` to check.

```
assets/js/
  00-config.js    all tunables
  01-math.js      RNG, vectors, matrices, Kalman filter, geometry
  10-world.js     GROUND TRUTH — waterway, traffic, own ship
  20-sensors.js   sensor catalogue, noisy observation generation
  30-tracking.js  association, tracking, fusion, duplicate merging
  40-worldmodel.js mapping, occupancy, corridor, prediction, risk
  50-renderer.js  projection and layers
  60-ui.js        panels, controls, inspector
  70-main.js      the loop
```

Coordinate system: world ENU (+X east, +Y north, +Z up), heading as a
compass bearing so forward is `(sin h, cos h, 0)`. Body frame +X forward,
+Y port, +Z up.

Rates: physics 60 Hz, sensors 25 Hz, world model ~15–25 Hz, UI 6 Hz, render
60 Hz. Deterministic under a single seed.

---

## Two deviations from the specification

**Renderer.** The spec prefers Next.js + React Three Fiber. `npm install` is
blocked in the environment this was built in, so that stack could not be
compiled or verified, and §50 requires each phase to actually run. The
renderer is therefore a hand-written 3D pipeline on Canvas 2D. It is one
module consuming only the world-model API; porting it to R3F replaces that
file and nothing else. Everything upstream — the part that matters — is the
architecture as specified.

**JavaScript, not TypeScript.** Same reason: no toolchain. The interfaces are
documented in ARCHITECTURE.md and the code is written against them; adding
`.d.ts` or converting is mechanical.

---

## Honest limitations

Read §12 of ARCHITECTURE.md before demonstrating this to anyone technical.
The significant ones: dimensions come from a class prior rather than LiDAR
extent; motion is constant-velocity only, so hard turns predict poorly for a
second or two; association is greedy nearest-neighbour, so genuinely
ambiguous crossing tracks can swap; and a track lost and re-acquired gets a
new identity (~1.65 numeric IDs per object over 24 s, against an ideal 1.0).

Each of these sits behind an interface built to be replaced.

---

## Measured behaviour

Recorded during verification, 1600×900, six scenarios:

- 56–60 FPS render, ~25 Hz sensors, ~22–26 Hz world model
- 25–35 live tracks, 0–2 ghost tracks
- Static objects estimated at 0.23 m/s mean (correct: they are static)
- Moving objects within 0.25 m/s of true speed
- Bridge clearance converging to within 0.1 m of truth by 380 m range
- Normal navigation produces no alerts; Collision escalates to critical

The ego-motion compensation is worth noting: radar reports range rate
relative to a moving sensor. Before that was corrected, every buoy appeared
to close on the vessel at own speed and the risk engine reported constant
false conflicts. If you extend the sensor model, keep that in mind.
