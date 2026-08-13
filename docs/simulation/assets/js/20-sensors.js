/* =============================================================================
   20-sensors.js — SENSOR SIMULATION.

   The only bridge between ground truth and CORNU. Everything downstream of
   here sees SensorObservation objects and nothing else.

     interface SensorObservation {
       timestamp, sensorId, measurementType,
       estimatedPosition {x,y,z},     // world frame, NOISY
       covariance [[..],[..]],        // 2x2 world XY
       classification?, classificationConfidence?,
       radialVelocity?, velocityEstimate?,
       sensorPosition,                // for occupancy ray casting
       truthId                        // DEBUG ONLY — never read by the world model
     }

   Swap SimulationPerceptionProvider for a ZED / radar / AIS provider and
   nothing downstream changes (§37).
   ========================================================================== */
(function (NS) {
  'use strict';
  const { V, bodyToWorld, worldToBody, clamp, wrapPi, rad, deg } = NS.math;

  /* --- sensor catalogue --------------------------------------------------
     pose: f/p/up metres in body frame; bearing: boresight relative to bow.  */
  const SENSORS = [
    { id: 'RADAR-360',     type: 'radar',  f:  -8, p: 0, up: 18, bearing: 0,   fov: 360, range: 1150, rate: 8,
      sigmaR: (r) => 5 + 0.008 * r, sigmaB: rad(0.85), doppler: true,  pd: 0.93, classes: null, latency: 0.10 },
    { id: 'RADAR-BOW',     type: 'radar',  f:  48, p: 0, up:  6, bearing: 0,   fov: 130, range: 820,  rate: 10,
      sigmaR: (r) => 3 + 0.005 * r, sigmaB: rad(0.55), doppler: true,  pd: 0.95, classes: null, latency: 0.08 },
    { id: 'LIDAR-BOW',     type: 'lidar',  f:  49, p: 0, up:  5, bearing: 0,   fov: 110, range: 185,  rate: 10,
      sigmaR: () => 0.14,           sigmaB: rad(0.05), doppler: false, pd: 0.97, classes: 'geometry', latency: 0.06 },
    { id: 'CAM-BOW-WIDE',  type: 'vision', f:  49, p: 0, up:  7, bearing: 0,   fov: 104, range: 330,  rate: 12,
      sigmaR: (r) => 2 + 0.055 * r, sigmaB: rad(0.14), doppler: false, pd: 0.90, classes: 'strong', latency: 0.14 },
    { id: 'CAM-BOW-TELE',  type: 'vision', f:  49, p: 0, up:  7, bearing: 0,   fov: 19,  range: 900,  rate: 10,
      sigmaR: (r) => 3 + 0.048 * r, sigmaB: rad(0.04), doppler: false, pd: 0.88, classes: 'excellent', latency: 0.16 },
    { id: 'CAM-MAST-PAN',  type: 'vision', f:  -8, p: 0, up: 19, bearing: 0,   fov: 300, range: 260,  rate: 8,
      sigmaR: (r) => 3 + 0.075 * r, sigmaB: rad(0.22), doppler: false, pd: 0.82, classes: 'strong', latency: 0.15 },
    { id: 'CAM-PORT',      type: 'vision', f:   0, p: 6, up:  6, bearing: 90,  fov: 100, range: 170,  rate: 10,
      sigmaR: (r) => 1.5 + 0.06 * r, sigmaB: rad(0.18), doppler: false, pd: 0.88, classes: 'strong', latency: 0.13 },
    { id: 'CAM-STBD',      type: 'vision', f:   0, p: -6, up: 6, bearing: -90, fov: 100, range: 170,  rate: 10,
      sigmaR: (r) => 1.5 + 0.06 * r, sigmaB: rad(0.18), doppler: false, pd: 0.88, classes: 'strong', latency: 0.13 },
    { id: 'RANGE-PORT',    type: 'lidar',  f: -10, p: 6, up:  4, bearing: 90,  fov: 120, range: 65,   rate: 15,
      sigmaR: () => 0.08,           sigmaB: rad(0.08), doppler: false, pd: 0.98, classes: 'geometry', latency: 0.04 },
    { id: 'RANGE-STBD',    type: 'lidar',  f: -10, p: -6, up: 4, bearing: -90, fov: 120, range: 65,   rate: 15,
      sigmaR: () => 0.08,           sigmaB: rad(0.08), doppler: false, pd: 0.98, classes: 'geometry', latency: 0.04 },
    { id: 'CAM-STERN',     type: 'vision', f: -51, p: 0, up:  6, bearing: 180, fov: 110, range: 210,  rate: 8,
      sigmaR: (r) => 2 + 0.07 * r,  sigmaB: rad(0.2),  doppler: false, pd: 0.84, classes: 'strong', latency: 0.15 },
    { id: 'RANGE-STERN',   type: 'lidar',  f: -52, p: 0, up:  4, bearing: 180, fov: 100, range: 70,   rate: 12,
      sigmaR: () => 0.1,            sigmaB: rad(0.09), doppler: false, pd: 0.97, classes: 'geometry', latency: 0.05 },
    { id: 'AIS',           type: 'ais',    f:  -8, p: 0, up: 20, bearing: 0,   fov: 360, range: 2600, rate: 0.6,
      sigmaR: () => 12,             sigmaB: rad(0.3),  doppler: false, pd: 0.99, classes: 'declared', latency: 2.2 }
  ];

  /* classification quality by sensor tier and range ---------------------- */
  /* Classification confidence falls with range, and the range at which a
     sensor can still classify scales with the object's apparent size. A buoy
     is unclassifiable at 400 m and obvious at 60 m; a 100 m hull is obvious
     much further out. That is a range limit, not a permanent ceiling. */
  function classifyQuality(tier, range, visualSize) {
    if (!tier) return 0;                                   // radar: geometry only
    const size = clamp(visualSize, 0.12, 2);
    const base = { declared: 0.97, geometry: 0.62, excellent: 0.96, strong: 0.93 }[tier] || 0.2;
    const scale = { declared: 1e6, geometry: 260, excellent: 900, strong: 420 }[tier] || 200;
    if (tier === 'declared') return base;
    /* effective range budget grows with apparent size */
    const budget = scale * clamp(size, 0.18, 1.4);
    return clamp(base * (1 - (range / budget) ** 1.4), 0.02, base);
  }

  /* what a sensor is likely to call a thing when it is not yet sure ------- */
  const CONFUSION = {
    vessel:            ['vessel', 'vessel', 'unknown', 'small_craft'],
    small_craft:       ['small_craft', 'small_craft', 'unknown', 'floating_obstacle'],
    floating_obstacle: ['floating_obstacle', 'unknown', 'unknown', 'small_craft'],
    buoy:              ['buoy', 'buoy', 'unknown', 'floating_obstacle'],
    bridge_pillar:     ['bridge_pillar', 'bridge_pillar', 'unknown', 'quay']
  };

  /* ---------------------------------------------------------------------
     SimulationPerceptionProvider
     ------------------------------------------------------------------ */
  function SimulationPerceptionProvider(world) {
    this.world = world;
    this.rng = new NS.math.Rng(NS.CFG.seed ^ 0x5f3a);
    this.acc = {};                     // per-sensor accumulator for rate limiting
    this.pending = [];                 // latency queue
    this.stats = { perSecond: 0, window: [], bySensor: {} };
    SENSORS.forEach((s) => { this.acc[s.id] = this.rng.next() / s.rate; });
  }

  SimulationPerceptionProvider.prototype.sensorList = function () { return SENSORS; };

  /* sensor world pose, given the current own-ship state */
  SimulationPerceptionProvider.prototype.poseOf = function (s, own) {
    return {
      position: bodyToWorld(own.position, own.heading, s.f, s.p, s.up),
      heading: wrapPi(own.heading - rad(s.bearing))     // bearing is to port-positive
    };
  };

  SimulationPerceptionProvider.prototype.status = function () {
    const faults = this.world.sensorFaults || {};
    return SENSORS.map((s) => ({
      id: s.id, type: s.type,
      state: faults[s.id] || 'ACTIVE',
      health: faults[s.id] === 'OFFLINE' ? 0 : faults[s.id] === 'DEGRADED' ? 0.63 : 1,
      rate: s.rate,
      observations: this.stats.bySensor[s.id] || 0
    }));
  };

  /* -----------------------------------------------------------------------
     getObservations(dt) — the PerceptionProvider interface.
     -------------------------------------------------------------------- */
  SimulationPerceptionProvider.prototype.getObservations = function (dt, now) {
    const world = this.world, own = world.ownShip, rng = this.rng;
    const faults = world.sensorFaults || {};
    const fresh = [];

    for (const s of SENSORS) {
      const fault = faults[s.id];
      if (fault === 'OFFLINE') { this.acc[s.id] = 0; continue; }
      this.acc[s.id] += dt;
      const period = 1 / s.rate;
      if (this.acc[s.id] < period) continue;
      this.acc[s.id] -= period;

      const pose = this.poseOf(s, own);
      const degradeFactor = fault === 'DEGRADED' ? 0.45 : 1;

      for (const e of world.entities) {
        if (s.type === 'ais' && !e.transmitsAis) continue;

        const rel = worldToBody(pose.position, pose.heading, e.position);
        const range = Math.hypot(rel.f, rel.p);
        if (range > s.range || range < 0.5) continue;

        /* field of view about the boresight */
        if (s.fov < 359) {
          const bearing = Math.abs(deg(Math.atan2(rel.p, rel.f)));
          if (bearing > s.fov / 2) continue;
        }

        /* occlusion (AIS and the mast radar see over hulls) */
        if (s.type !== 'ais' && s.up < 12 &&
            world.occluded(pose.position, e.position, e.id)) continue;

        /* detection probability falls with range and rises with signature */
        const sig = s.type === 'radar' ? e.radarCrossSection : e.visualSize;
        const rangeFrac = range / s.range;
        const pd = s.pd * degradeFactor *
                   clamp(1.05 - rangeFrac * rangeFrac * 0.85, 0.04, 1) *
                   clamp(0.35 + sig, 0.12, 1);
        if (rng.next() > pd) continue;                   // missed detection

        /* --- noisy polar measurement → world XY + covariance ------------- */
        const sr = s.sigmaR(range) / degradeFactor;
        const sb = s.sigmaB / degradeFactor;
        const trueBeta = Math.atan2(e.position.y - pose.position.y,
                                    e.position.x - pose.position.x);
        const mr = range + rng.normal(0, sr);
        const mb = trueBeta + rng.normal(0, sb);
        const est = {
          x: pose.position.x + mr * Math.cos(mb),
          y: pose.position.y + mr * Math.sin(mb),
          z: 0
        };
        /* Jacobian of (r,β) → (x,y), giving the Cartesian covariance */
        const c = Math.cos(mb), sn = Math.sin(mb);
        const J = [[c, -mr * sn], [sn, mr * c]];
        const Rp = [[sr * sr, 0], [0, sb * sb]];
        const JR = [
          [J[0][0] * Rp[0][0], J[0][1] * Rp[1][1]],
          [J[1][0] * Rp[0][0], J[1][1] * Rp[1][1]]
        ];
        const cov = [
          [JR[0][0] * J[0][0] + JR[0][1] * J[0][1], JR[0][0] * J[1][0] + JR[0][1] * J[1][1]],
          [JR[1][0] * J[0][0] + JR[1][1] * J[0][1], JR[1][0] * J[1][0] + JR[1][1] * J[1][1]]
        ];

        const obs = {
          timestamp: now,
          sensorId: s.id,
          measurementType: s.type,
          estimatedPosition: est,
          covariance: cov,
          sensorPosition: V.clone(pose.position),
          range: mr,
          truthId: e.id                                  // debug overlay only
        };

        /* --- Doppler ---------------------------------------------------- */
        if (s.doppler) {
          /* A radar measures range rate RELATIVE to itself. The observation
             therefore carries the sensor's own velocity so that the tracker
             can compensate for ego motion; without that, every static object
             appears to close on the vessel at own speed. */
          const ux = Math.cos(trueBeta), uy = Math.sin(trueBeta);
          const ownV = own.velocity();
          const relV = { x: e.velocity.x - ownV.x, y: e.velocity.y - ownV.y };
          obs.radialVelocity = (relV.x * ux + relV.y * uy) + rng.normal(0, 0.28);
          obs.radialUnit = { x: ux, y: uy };
          obs.sensorVelocity = { x: ownV.x, y: ownV.y, z: 0 };
        }

        /* --- classification --------------------------------------------- */
        const q = classifyQuality(s.classes, range, e.visualSize) * degradeFactor;
        if (q > 0.03) {
          const table = CONFUSION[e.cls] || ['unknown'];
          /* with probability q report the true class, otherwise a plausible confusion */
          const correct = rng.next() < q;
          obs.classification = correct ? e.cls : rng.pick(table);
          obs.classificationConfidence = clamp(q * (correct ? 1 : 0.55), 0.05, 0.97);
        }

        /* --- AIS also declares velocity --------------------------------- */
        if (s.type === 'ais') {
          obs.velocityEstimate = {
            x: e.velocity.x + rng.normal(0, 0.12),
            y: e.velocity.y + rng.normal(0, 0.12), z: 0
          };
        }

        this.pending.push({ at: now + s.latency, obs });
      }
    }

    /* release observations whose latency has elapsed */
    const still = [];
    for (const p of this.pending) {
      if (p.at <= now) fresh.push(p.obs); else still.push(p);
    }
    this.pending = still;

    /* throughput statistics */
    this.stats.window.push({ t: now, n: fresh.length });
    while (this.stats.window.length && now - this.stats.window[0].t > 1) this.stats.window.shift();
    this.stats.perSecond = this.stats.window.reduce((a, b) => a + b.n, 0);
    for (const o of fresh) this.stats.bySensor[o.sensorId] = (this.stats.bySensor[o.sensorId] || 0) + 1;

    return fresh;
  };

  /* --- ego state estimate: GNSS + IMU, also noisy ------------------------ */
  SimulationPerceptionProvider.prototype.getEgoState = function (now) {
    const own = this.world.ownShip, rng = this.rng;
    const faults = this.world.sensorFaults || {};
    const gnssOff = faults['GNSS'] === 'OFFLINE';
    const sigma = gnssOff ? 6.5 : 0.65;
    return {
      timestamp: now,
      position: {
        x: own.position.x + rng.normal(0, sigma),
        y: own.position.y + rng.normal(0, sigma), z: 0
      },
      heading: own.heading + rng.normal(0, rad(0.35)),
      speed: own.speed + rng.normal(0, 0.05),
      yawRate: own.yawRate + rng.normal(0, 0.0016),
      dims: own.dims,
      positionSigma: sigma
    };
  };

  NS.sensors = { SENSORS, SimulationPerceptionProvider };
})(window.CORNU);

/* =============================================================================
   20b — structural returns: banks and bridges.

   Point-target detections alone cannot reconstruct a waterway. Ranging
   sensors also sweep rays that terminate on the bank, and forward vision
   measures bridge geometry. These enter the same observation stream with
   distinct measurementTypes, and the world model routes them to the static
   mapper rather than the tracker.
   ========================================================================== */
(function (NS) {
  'use strict';
  const { worldToBody, clamp, rad, deg } = NS.math;
  const P = NS.sensors.SimulationPerceptionProvider;

  /* precompute bank polylines once per world */
  function bankPolylines(world) {
    if (world._banks) return world._banks;
    const ww = world.waterway, left = [], right = [];
    for (const st of ww.stations) {
      left.push({ x: st.p.x + st.normal.x * st.halfWidth, y: st.p.y + st.normal.y * st.halfWidth, s: st.s });
      right.push({ x: st.p.x - st.normal.x * st.halfWidth, y: st.p.y - st.normal.y * st.halfWidth, s: st.s });
    }
    world._banks = { left, right };
    return world._banks;
  }

  /* nearest ray/segment intersection within a station window */
  function castRay(world, origin, beta, maxRange, ownStation) {
    const banks = bankPolylines(world);
    const dx = Math.cos(beta), dy = Math.sin(beta);
    let best = null;
    for (const side of ['left', 'right']) {
      const line = banks[side];
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i], b = line[i + 1];
        if (Math.abs(a.s - ownStation) > 420) continue;      // spatial index by station
        const ex = b.x - a.x, ey = b.y - a.y;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((a.x - origin.x) * ey - (a.y - origin.y) * ex) / den;
        const u = ((a.x - origin.x) * dy - (a.y - origin.y) * dx) / den;
        if (t > 0.5 && t < maxRange && u >= 0 && u <= 1) {
          if (!best || t < best.t) best = { t, side, x: origin.x + dx * t, y: origin.y + dy * t };
        }
      }
    }
    return best;
  }

  /* --- bank returns from the ranging sensors ---------------------------- */
  P.prototype.getStructuralObservations = function (dt, now) {
    const world = this.world, own = world.ownShip, rng = this.rng;
    const faults = world.sensorFaults || {};
    const out = [];
    const ownStation = own.stationEstimate;

    const scanners = NS.sensors.SENSORS.filter(
      (s) => (s.type === 'lidar' || s.id === 'RADAR-BOW' || s.id === 'RADAR-360')
    );

    for (const s of scanners) {
      if (faults[s.id] === 'OFFLINE') continue;
      this._bankAcc = this._bankAcc || {};
      this._bankAcc[s.id] = (this._bankAcc[s.id] || 0) + dt;
      const period = 1 / Math.min(s.rate, 6);
      if (this._bankAcc[s.id] < period) continue;
      this._bankAcc[s.id] -= period;

      const pose = this.poseOf(s, own);
      const rays = s.fov > 359 ? 30 : 16;
      const span = s.fov > 359 ? 360 : s.fov;
      for (let i = 0; i < rays; i++) {
        const relB = rad(-span / 2 + (span * (i + 0.5)) / rays);
        const beta = Math.atan2(Math.cos(pose.heading + relB), Math.sin(pose.heading + relB));
        /* pose.heading is a compass bearing; convert to a maths angle */
        const mathBeta = Math.atan2(Math.cos(pose.heading + relB), Math.sin(pose.heading + relB));
        void beta;
        const hit = castRay(world, pose.position, mathBeta, s.range, ownStation);
        if (!hit) continue;
        if (rng.next() > 0.86) continue;                   // sparse returns
        const sr = s.sigmaR(hit.t);
        const mr = hit.t + rng.normal(0, sr);
        const mb = mathBeta + rng.normal(0, s.sigmaB);
        out.push({
          timestamp: now,
          sensorId: s.id,
          measurementType: 'bank_return',
          estimatedPosition: {
            x: pose.position.x + mr * Math.cos(mb),
            y: pose.position.y + mr * Math.sin(mb), z: 0
          },
          sigma: sr,
          sensorPosition: { x: pose.position.x, y: pose.position.y, z: 0 },
          range: mr
        });
      }
    }

    /* --- bridge geometry from forward vision + radar -------------------- */
    const br = world.bridge;
    if (br) {
      this._brAcc = (this._brAcc || 0) + dt;
      if (this._brAcc > 0.2) {
        this._brAcc = 0;
        const rel = worldToBody(own.position, own.heading, br.centre);
        const range = Math.hypot(rel.f, rel.p);
        const ahead = rel.f > 0;
        const bearing = Math.abs(deg(Math.atan2(rel.p, rel.f)));
        const teleOk = faults['CAM-BOW-TELE'] !== 'OFFLINE';
        if (ahead && range < 780 && bearing < 42) {
          /* measurement quality improves as the vessel closes */
          const q = clamp(1 - range / 820, 0.05, 1);
          const sClear = 2.6 * (1 - q) + 0.09;
          const sWidth = 11 * (1 - q) + 0.5;
          const sRange = 9 * (1 - q) + 0.6;
          out.push({
            timestamp: now,
            sensorId: teleOk ? 'CAM-BOW-TELE' : 'RADAR-BOW',
            measurementType: 'bridge',
            estimatedPosition: {
              x: br.centre.x + rng.normal(0, sRange * 0.4),
              y: br.centre.y + rng.normal(0, sRange * 0.4), z: 0
            },
            range: range + rng.normal(0, sRange),
            clearance: br.clearance + rng.normal(0, sClear),
            openingWidth: br.openingWidth + rng.normal(0, sWidth),
            openingOffset: br.openingOffset + rng.normal(0, sWidth * 0.35),
            heading: br.heading,
            quality: q
          });
        }
      }
    }

    return out;
  };
})(window.CORNU);
