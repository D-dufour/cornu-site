# CORNU — Maritime Spatial Intelligence System
## Architecture

This document answers §53 of the specification: the proposed architecture,
interfaces, coordinate system, update rates, world-model structure,
observation generation, tracking and fusion approach, rendering
architecture and directory layout.

---

## 1. The one rule

```
GROUND TRUTH   ≠   SENSOR OBSERVATIONS   ≠   CORNU ESTIMATE
```

`10-world.js` owns ground truth. `20-sensors.js` is the **only** module
permitted to read it. Everything downstream sees `SensorObservation` objects
and nothing else. The renderer draws from the world model; its single
ground-truth access is the explicit **Ground truth** overlay layer, which
exists precisely so the operator can see the gap between reality and
estimate.

This is enforceable by inspection: search the codebase for `world.entities`
and it appears in `20-sensors.js` (observation generation) and in
`Renderer.drawGroundTruth` (the overlay). Nowhere else.

---

## 2. Pipeline

```
            SYNTHETIC PHYSICAL WORLD          10-world.js
                      │
                      ▼
              SIMULATED SENSORS              20-sensors.js
        range/bearing noise · missed detections
        occlusion · latency · class confusion
                      │
                      ▼
             NOISY OBSERVATIONS
          ┌───────────┴───────────┐
          ▼                       ▼
   point detections        structural returns
          │                 (bank, bridge)
          ▼                       │
    DATA ASSOCIATION              │            30-tracking.js
    Mahalanobis gate,             │
    greedy global NN              │
          ▼                       │
       TRACKING                   │
    constant-velocity KF          │
          ▼                       │
    SENSOR FUSION                 │
    position: KF update           │
    velocity: Doppler +           │
      ego-motion compensation     │
    class: log-odds → softmax     │
          │                       │
          └───────────┬───────────┘
                      ▼
           SEMANTIC WORLD MODEL              40-worldmodel.js
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
  SPATIAL MEMORY   OCCUPANCY   BRIDGE ESTIMATE
  (running-mean    (sparse
   bank cells)      log-odds)
        └─────────────┼─────────────┘
                      ▼
                 PREDICTION
      own swept volume · entity trajectories
                      ▼
                 RISK ENGINE
      CPA/TCPA · swept-volume conflict ·
      corridor width · bridge clearance
                      ▼
              VISUALISATION / UI            50-renderer.js, 60-ui.js
```

---

## 3. Coordinate system

**World frame — ENU**

| axis | direction | unit |
|---|---|---|
| +X | east | m |
| +Y | north | m |
| +Z | up | m |

Heading is a **compass bearing**: 0 = +Y (north), increasing clockwise, in
radians. The forward unit vector is therefore `(sin h, cos h, 0)` — not the
usual `(cos, sin)`, so read `math.fwd()` before doing trigonometry here.

**Body frame**

| axis | direction |
|---|---|
| +X | forward (bow) |
| +Y | port |
| +Z | up |

Sensor poses are declared in the body frame as `(f, p, up)` plus a boresight
bearing in degrees to port. `math.bodyToWorld()` and `math.worldToBody()`
are the only conversions; every sensor transform resolves through them into
the common world frame.

---

## 4. Update rates

| stage | rate | where |
|---|---|---|
| ground-truth physics | 60 Hz | fixed sub-stepping in `App.stepSim` |
| sensor simulation | 25 Hz | per-sensor accumulators, each sensor at its own rate (0.6–15 Hz) |
| world model | 15 Hz nominal | association, tracking, fusion, mapping |
| risk + prediction | with world model | cheap enough not to warrant its own rate |
| UI panels | 6 Hz | DOM writes are the expensive part |
| render | rAF (60 Hz) | always draws the latest model |

Measured: 56–60 FPS render, ~25 Hz sensors, ~22–26 Hz world model, with
~25–35 live tracks and ~900 occupancy cells.

The simulation is **deterministic**: a single seeded xorshift32 RNG
(`CFG.seed`) drives world construction, sensor noise and detection dropouts.
Same seed, same scenario, same run.

---

## 5. Interfaces

```ts
interface SensorObservation {
  timestamp: number;
  sensorId: string;
  measurementType: 'vision' | 'radar' | 'lidar' | 'ais'
                 | 'bank_return' | 'bridge';
  estimatedPosition: Vector3;      // world frame, NOISY
  covariance: Matrix2x2;           // world XY, from the polar Jacobian
  sensorPosition: Vector3;         // for occupancy ray casting
  classification?: string;
  classificationConfidence?: number;
  radialVelocity?: number;         // RELATIVE range rate
  radialUnit?: Vector2;
  sensorVelocity?: Vector3;        // so the tracker can remove ego motion
  velocityEstimate?: Vector3;      // AIS only
  truthId?: string;                // DEBUG ONLY — never read downstream
}

interface WorldEntity {
  id: string;                      // UNKNOWN_012 → VESSEL_012 on promotion
  semanticClass: 'vessel' | 'small_craft' | 'floating_obstacle'
               | 'buoy' | 'bridge_pillar' | 'unknown';
  classConfidence: number;
  position: Vector3;  heading: number;  dimensions: Vector3;
  velocity: Vector3;  speed: number;
  confidence: number;
  positionUncertainty: number;     // 1σ, metres
  velocityUncertainty: number;
  ellipse: { a, b, angle };        // covariance ellipse for rendering
  firstObserved, lastObserved, ageSeconds, staleSeconds: number;
  observationCount: number;
  contributingSensors: string[];
  state: 'TENTATIVE' | 'TRACKED' | 'PREDICTED';
  history: Vector2[];
  prediction: { points: { t, x, y, sigma }[] };
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
}

interface PerceptionProvider {
  getObservations(dt, now): SensorObservation[];
  getStructuralObservations(dt, now): SensorObservation[];
  getEgoState(now): EgoState;
  sensorList(): SensorDefinition[];
  status(): SensorStatus[];
}
```

Current implementation: `SimulationPerceptionProvider`.
Future: `ZEDCameraProvider`, `RadarProvider`, `LidarProvider`, `AISProvider`,
`RealWorldFusionProvider`. Nothing downstream of the interface changes.

**World model API** (§38), consumed by the renderer and UI:

```js
worldModel.update(observations, structural, ego, dt, now)
worldModel.getEntities()        worldModel.getNavigableSpace()
worldModel.getPredictions()     worldModel.getRisks()
worldModel.getBridgeState()     worldModel.getOccupancy()
worldModel.getOwnVessel()       worldModel.overallRisk()
```

---

## 6. Sensor model

Thirteen sensors: 2 radar, 4 ranging/LiDAR, 6 cameras, 1 AIS, plus GNSS/IMU
for ego state. Each declares pose, range, FOV, rate, per-range noise
functions, detection probability, classification tier and latency.

A measurement is generated in polar form and converted to Cartesian with the
Jacobian, so the covariance is correctly **range-elongated** — a distant
radar contact is uncertain far more in range than in bearing, and the ellipse
you see on screen shows exactly that.

Modelled effects: range and bearing noise, detection probability falling with
range and rising with signature, occlusion by hulls (line-of-sight segment
test, with mast-mounted and AIS sensors seeing over), classification
confusion with a per-class table, per-sensor latency, and scripted
degradation/failure.

Classification confidence falls with range, and the range budget scales with
apparent size: a buoy is unclassifiable at 400 m and obvious at 60 m; a 100 m
hull is recognisable much further out.

**Structural returns.** Point detections alone cannot reconstruct a waterway,
so ranging sensors also sweep rays that terminate on the bank
(`bank_return`), and forward vision measures bridge geometry (`bridge`) with
noise that shrinks as the vessel closes. These route to the static mapper and
bridge estimator rather than the tracker.

---

## 7. Tracking and fusion

**Association** — greedy global nearest neighbour over a Mahalanobis gate
(4.2σ, hard-capped at 120 m), pairs sorted ascending, one observation per
track per cycle.

**State** — linear Kalman filter, state `[x, y, vx, vy]`, constant velocity,
`Q` derived from a white-acceleration model. Deliberately the honest
baseline; `Track` and `Tracker` are separated from everything else so an EKF,
UKF, IMM or factor graph replaces them without touching the world model.

**Position fusion** — sequential KF updates, each with that sensor's own `R`.
A LiDAR return at 0.14 m and a radar return at 8 m are weighted correctly by
construction.

**Velocity fusion** — radar Doppler updates the velocity along the bearing.
Critically, a radar measures range rate **relative to itself**, so the
observation carries `sensorVelocity` and the tracker converts:

```
v_target · u  =  ṙ_relative  +  v_sensor · u
```

Without this compensation every static object appears to close on the vessel
at own speed, and the risk engine invents conflicts with buoys. Measured
after the fix: static objects estimate 0.23 m/s mean, moving objects within
0.25 m/s of truth.

**Classification fusion** — per-class log-odds accumulated across sensors,
weighted so that a *new* sensor tier counts more than another frame from one
already contributing; softmax gives the posterior.

**Dimensions** follow the class posterior, blended from a neutral prior, and
only once the classifier passes a confidence threshold. An unsure track must
not be reasoned about as an 85 m cargo vessel. *(Simplification: real extent
comes from LiDAR cluster geometry; here it is a class prior. The interface is
unchanged when that is replaced.)*

**Persistence** — confidence decays when unobserved, the track coasts on dead
reckoning and is marked `PREDICTED`, and is deleted only when confidence
collapses or the coast limit is hit (§27).

**Duplicate resolution** — independent sensors with different biases can open
two tracks on one object. Tracks that sit close together *and* agree on
velocity are merged, keeping the better-observed one. Measured ghost rate
after merging: 0–2 tracks out of ~26.

---

## 8. World model structure

```
WorldModel
├── ownVessel          ego state from GNSS/IMU, with its own σ
├── staticEnvironment
│   ├── staticMap      running-mean bank cells, confidence ~ 1−e^(−n/5)
│   └── bridgeEst      quality-weighted fusion of repeated measurements
├── dynamicEntities    WorldEntity[] from the tracker
├── occupancy          sparse log-odds hash, free by ray casting
├── navigableSpace     corridor measured along the predicted path
├── predictions        own swept volume + entity trajectories
└── riskState          per-entity CPA/TCPA/conflict + alerts
```

**Spatial memory.** Bank returns bin into a coarse hash; each cell keeps a
running mean, so geometry stabilises the more often it is observed, and cells
carry a confidence that grows with observation count. The map is pruned by
distance, not by frame — knowledge persists as the vessel travels.

**Occupancy** is a sparse vessel-centric log-odds grid at 8 m cells. Each
observation casts a free-space ray from the sensor and marks the termination
occupied. No millions of cubes: ~900 live cells.

**Navigable space** is measured, not assumed. The predicted own path provides
the spine; at each station the nearest mapped structure to port and starboard
is found in the local along/across frame; the result is inset by half-beam
plus safety margin, then shrunk further where a tracked hazard intrudes.

---

## 9. Prediction and risk

**Own swept volume** — the full 100 m hull footprint propagated to +60 s with
the estimated yaw rate relaxing toward straight, footprints every 2.5 s,
beam inflated by bounded heading uncertainty. Bounded matters: an unbounded
corridor eventually intersects everything and the alert stops meaning
anything.

**Entity prediction** — constant velocity with σ growing from position and
velocity uncertainty, drawn as widening ellipses rather than a confident line.

**Conflict** — separating-axis overlap between the own swept footprint at
time *t* and the entity's predicted footprint at the same *t*, both inflated
by capped uncertainty. Extrapolation is **gated on velocity quality**: a
track whose velocity is barely observed gets a 10 s trust horizon, not 60 s.

**Risk** is not distance-based. It combines CPA, TCPA, predicted conflict
time, closing geometry, position uncertainty (an unsure track is not a safe
track), track state (a coasting track is escalated), corridor width and
bridge clearance versus air draft.

---

## 10. Rendering

A minimal 3D pipeline on Canvas 2D: view basis → perspective divide →
near-plane segment clipping → painter-ordered layers, with screen-space
greedy label placement so a cluttered scene degrades instead of turning into
soup.

**Why not Three.js:** this environment blocks `npm install`, so a Vite +
React Three Fiber build could not be compiled or verified here, and §50
requires every phase to run before moving on. The visual language the spec
asks for — wireframe hulls, corridors, ellipses, annotations — is
line-and-text work that Canvas 2D renders sharply and cheaply. The renderer
is a single module consuming only the world-model API, so replacing it with
R3F is a contained job: keep `Camera`/`Projector` semantics, map each `draw*`
method to a component.

Camera modes: chase, bird, bow, free (orbit/zoom/pan on drag and wheel).
View modes: world model / blended / ground truth, implemented as layer
presets so the operator can compare reality with the estimate directly.
Twelve independently toggleable layers.

---

## 11. Directory structure

```
cornu-sim/
├── index.html
├── assets/
│   ├── css/cornu.css
│   └── js/
│       ├── 00-config.js       tunables — no magic numbers elsewhere
│       ├── 01-math.js         RNG, vectors, matrices, Kalman, geometry
│       ├── 10-world.js        GROUND TRUTH: waterway, traffic, own ship
│       ├── 20-sensors.js      sensor catalogue + observation generation
│       ├── 30-tracking.js     association, KF tracking, fusion, merging
│       ├── 40-worldmodel.js   mapping, occupancy, corridor, prediction, risk
│       ├── 50-renderer.js     projection + layers
│       ├── 60-ui.js           operator panels, controls, inspector
│       └── 70-main.js         the loop
├── ARCHITECTURE.md
└── README.md
```

Files are numbered by pipeline stage and loaded as classic scripts sharing a
`CORNU` namespace, so the folder opens by double-click with no server and no
build step, while remaining genuinely modular. The numbering is also the
dependency order.

---

## 12. Known simplifications

Stated plainly, because the spec asks for architecture that can be replaced
rather than tricks that cannot:

1. **Extent estimation** — object dimensions come from a class prior, not
   from LiDAR cluster geometry.
2. **Motion model** — constant velocity only. No IMM, so a vessel executing a
   hard turn is predicted poorly for a second or two.
3. **Association** — greedy global NN. No JPDA or MHT, so genuinely ambiguous
   crossing tracks can swap identity.
4. **Track re-identification** — a track lost beyond the coast limit and
   re-acquired later gets a new number. Measured ~1.65 numeric identities per
   object over 24 s; ideal is 1.0. Appearance features would close this.
5. **Bank returns** are ray-cast against ground-truth polylines rather than
   simulated from a point cloud with material properties.
6. **No lock cycle** — the lock exists as geometry, not as a passable state
   machine.
7. **Semantic graph** (§45) is not implemented; entities carry the fields it
   would need, but relationships are not yet first-class.
8. **Vertical geometry** is thin: air draft and bridge clearance are modelled,
   full 3D occupancy is not.
