/* =============================================================================
   40-worldmodel.js — THE SEMANTIC WORLD MODEL.

   Everything here is derived from SensorObservations. Nothing in this file
   may read CORNU.world ground truth. The renderer draws from the object this
   module returns.

     WorldModel
       ├── ownVessel          (ego state, from GNSS/IMU)
       ├── staticEnvironment  (accumulated bank points, bridge estimate)
       ├── dynamicEntities    (tracks, from 30-tracking)
       ├── occupancy          (sparse log-odds grid)
       ├── navigableSpace     (corridor measured along the predicted path)
       ├── predictions        (own swept volume + entity trajectories)
       └── riskState          (CPA/TCPA, conflicts, alerts)
   ========================================================================== */
(function (NS) {
  'use strict';
  const { V, clamp, lerp, fwd, port, wrapPi, rectCorners, polysOverlap, cpa, sigmoid, logit } = NS.math;
  const CFG = NS.CFG;

  /* =====================================================================
     Static map — accumulating spatial memory of structure (§44).
     Bank returns are binned into a coarse hash; each cell keeps a running
     mean, so geometry becomes more stable the more often it is observed.
     ================================================================== */
  function StaticMap() { this.cells = new Map(); this.bin = 9; }

  StaticMap.prototype.key = function (x, y) {
    return Math.round(x / this.bin) + ':' + Math.round(y / this.bin);
  };
  StaticMap.prototype.ingest = function (obs, now) {
    const p = obs.estimatedPosition;
    const k = this.key(p.x, p.y);
    let c = this.cells.get(k);
    if (!c) { c = { x: p.x, y: p.y, n: 0, sx: 0, sy: 0, first: now, last: now }; this.cells.set(k, c); }
    c.sx += p.x; c.sy += p.y; c.n++;
    c.x = c.sx / c.n; c.y = c.sy / c.n;      // running mean → refinement over time
    c.last = now;
  };
  /* confidence in a cell grows with repeated observation, saturating */
  StaticMap.prototype.confidenceOf = function (c) { return clamp(1 - Math.exp(-c.n / 5), 0, 0.99); };
  StaticMap.prototype.prune = function (centre, radius) {
    for (const [k, c] of this.cells) {
      if (Math.hypot(c.x - centre.x, c.y - centre.y) > radius) this.cells.delete(k);
    }
  };
  StaticMap.prototype.near = function (centre, radius) {
    const out = [], r2 = radius * radius;
    for (const c of this.cells.values()) {
      const dx = c.x - centre.x, dy = c.y - centre.y;
      if (dx * dx + dy * dy < r2) out.push(c);
    }
    return out;
  };

  /* =====================================================================
     Occupancy — sparse vessel-centric log-odds grid (§13).
     Rays mark free space; terminations mark occupied.
     ================================================================== */
  function Occupancy(cfg) { this.cells = new Map(); this.cfg = cfg; }
  Occupancy.prototype.idx = function (x, y) {
    return Math.floor(x / this.cfg.cell) + ':' + Math.floor(y / this.cfg.cell);
  };
  Occupancy.prototype.bump = function (x, y, delta) {
    const k = this.idx(x, y);
    let c = this.cells.get(k);
    if (!c) {
      c = { x: (Math.floor(x / this.cfg.cell) + 0.5) * this.cfg.cell,
            y: (Math.floor(y / this.cfg.cell) + 0.5) * this.cfg.cell, l: 0 };
      this.cells.set(k, c);
    }
    c.l = clamp(c.l + delta, this.cfg.lMin, this.cfg.lMax);
  };
  Occupancy.prototype.castFree = function (from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    const step = this.cfg.cell * 0.9;
    const n = Math.min(140, Math.floor(dist / step));
    for (let i = 1; i < n; i++) {
      const t = (i * step) / dist;
      this.bump(from.x + dx * t, from.y + dy * t, this.cfg.lFree);
    }
  };
  Occupancy.prototype.ingest = function (obs) {
    if (!obs.sensorPosition) return;
    this.castFree(obs.sensorPosition, obs.estimatedPosition);
    this.bump(obs.estimatedPosition.x, obs.estimatedPosition.y, this.cfg.lOcc);
  };
  Occupancy.prototype.prune = function (centre) {
    const r = this.cfg.halfExtent;
    for (const [k, c] of this.cells) {
      if (Math.abs(c.x - centre.x) > r || Math.abs(c.y - centre.y) > r) this.cells.delete(k);
    }
  };
  Occupancy.prototype.list = function () {
    const occ = [], free = [];
    for (const c of this.cells.values()) {
      const p = sigmoid(c.l);
      if (p > this.cfg.occThreshold) occ.push({ x: c.x, y: c.y, p });
      else if (p < this.cfg.freeThreshold) free.push({ x: c.x, y: c.y, p });
    }
    return { occupied: occ, free: free, total: this.cells.size };
  };

  /* =====================================================================
     Bridge estimator (§15) — weighted fusion of repeated measurements.
     ================================================================== */
  function BridgeEstimator() { this.state = null; }
  BridgeEstimator.prototype.ingest = function (obs, now) {
    if (!this.state) {
      this.state = {
        id: 'BRIDGE_003', clearance: obs.clearance, openingWidth: obs.openingWidth,
        openingOffset: obs.openingOffset, position: obs.estimatedPosition,
        heading: obs.heading, weight: 0, observations: 0, confidence: 0.15, lastSeen: now
      };
    }
    const s = this.state, w = obs.quality * obs.quality + 0.02;
    const tw = s.weight + w;
    s.clearance = (s.clearance * s.weight + obs.clearance * w) / tw;
    s.openingWidth = (s.openingWidth * s.weight + obs.openingWidth * w) / tw;
    s.openingOffset = (s.openingOffset * s.weight + obs.openingOffset * w) / tw;
    s.position = {
      x: (s.position.x * s.weight + obs.estimatedPosition.x * w) / tw,
      y: (s.position.y * s.weight + obs.estimatedPosition.y * w) / tw, z: 0
    };
    s.heading = obs.heading;
    s.weight = tw;
    s.observations++;
    s.confidence = clamp(1 - Math.exp(-tw / 2.2), 0, 0.995);
    s.lastSeen = now;
  };

  /* =====================================================================
     WorldModel
     ================================================================== */
  function WorldModel(provider) {
    this.provider = provider;
    this.tracker = new NS.tracking.Tracker();
    this.staticMap = new StaticMap();
    this.occupancy = new Occupancy(CFG.occupancy);
    this.bridgeEst = new BridgeEstimator();
    this.ownVessel = null;
    this.entities = [];
    this.corridor = null;
    this.sweptVolume = null;
    this.risks = [];
    this.alerts = [];
    this.time = 0;
    this.updateCount = 0;
    this.observationCount = 0;
  }

  /* --- the API of §38 ---------------------------------------------------- */
  WorldModel.prototype.getEntities = function () { return this.entities; };
  WorldModel.prototype.getNavigableSpace = function () { return this.corridor; };
  WorldModel.prototype.getPredictions = function () {
    return { own: this.sweptVolume, entities: this.entities.map((e) => e.prediction) };
  };
  WorldModel.prototype.getRisks = function () { return this.risks; };
  WorldModel.prototype.getBridgeState = function () { return this.bridgeEst.state; };
  WorldModel.prototype.getOccupancy = function () { return this.occupancy.list(); };
  WorldModel.prototype.getOwnVessel = function () { return this.ownVessel; };

  /* -----------------------------------------------------------------------
     update(observations, structural, ego, dt, now)
     -------------------------------------------------------------------- */
  WorldModel.prototype.update = function (observations, structural, ego, dt, now) {
    this.time = now;
    this.updateCount++;
    this.observationCount += observations.length + structural.length;

    /* 1. ego state ------------------------------------------------------- */
    this.ownVessel = {
      position: ego.position,
      heading: ego.heading,
      speed: ego.speed,
      yawRate: ego.yawRate,
      dimensions: ego.dims,
      positionUncertainty: ego.positionSigma,
      velocity: { x: fwd(ego.heading).x * ego.speed, y: fwd(ego.heading).y * ego.speed, z: 0 }
    };

    /* 2. route the observation stream ------------------------------------ */
    const trackable = [];
    for (const o of observations) trackable.push(o);
    for (const o of structural) {
      if (o.measurementType === 'bank_return') {
        this.staticMap.ingest(o, now);
        this.occupancy.ingest(o);
      } else if (o.measurementType === 'bridge') {
        this.bridgeEst.ingest(o, now);
      }
    }
    for (const o of observations) this.occupancy.ingest(o);

    /* 3. association / tracking / fusion --------------------------------- */
    const tracks = this.tracker.update(trackable, dt, now);
    this.entities = tracks.map((t) => t.toEntity(now));

    /* 4. spatial housekeeping -------------------------------------------- */
    this.staticMap.prune(this.ownVessel.position, 900);
    this.occupancy.prune(this.ownVessel.position);

    /* 5. prediction ------------------------------------------------------- */
    this.sweptVolume = this.predictOwnSweptVolume();
    for (const e of this.entities) e.prediction = this.predictEntity(e);

    /* 6. navigable space -------------------------------------------------- */
    this.corridor = this.computeCorridor();

    /* 7. risk -------------------------------------------------------------- */
    this.assessRisk();

    return this;
  };

  /* -----------------------------------------------------------------------
     Own swept volume (§16) — the whole 100 m hull, not its centre.
     Dead reckoning from the estimated yaw rate, decaying toward straight.
     -------------------------------------------------------------------- */
  WorldModel.prototype.predictOwnSweptVolume = function () {
    const own = this.ownVessel;
    if (!own) return null;
    const horizon = CFG.prediction.horizons[CFG.prediction.horizons.length - 1];
    const step = CFG.prediction.step;
    const foot = [], spine = [];
    let p = V.clone(own.position), h = own.heading, yaw = own.yawRate;

    for (let t = 0; t <= horizon; t += step) {
      if (t > 0) {
        const sub = step / 4;
        for (let k = 0; k < 4; k++) {
          yaw *= Math.exp(-sub / 22);                 // helm relaxes toward straight
          h = wrapPi(h + yaw * sub);
          const F = fwd(h);
          p = { x: p.x + F.x * own.speed * sub, y: p.y + F.y * own.speed * sub, z: 0 };
        }
      }
      spine.push({ x: p.x, y: p.y, t });
      /* lateral growth models heading uncertainty accumulating with time */
      const grow = Math.min(CFG.prediction.growthPerSec * t, CFG.prediction.maxGrowth);
      foot.push({
        t,
        corners: rectCorners(p, h, own.dimensions.length, own.dimensions.beam + grow * 2),
        heading: h,
        centre: { x: p.x, y: p.y, z: 0 },
        beam: own.dimensions.beam + grow * 2
      });
    }
    return { footprints: foot, spine, horizon };
  };

  /* -----------------------------------------------------------------------
     Entity prediction (§17) — constant velocity, widening uncertainty.
     -------------------------------------------------------------------- */
  WorldModel.prototype.predictEntity = function (e) {
    const pts = [];
    const sigma0 = e.positionUncertainty;
    for (const t of [0].concat(CFG.prediction.horizons)) {
      pts.push({
        t,
        x: e.position.x + e.velocity.x * t,
        y: e.position.y + e.velocity.y * t,
        sigma: sigma0 + e.velocityUncertainty * t + 0.18 * t
      });
    }
    return { points: pts };
  };

  /* -----------------------------------------------------------------------
     Navigable corridor (§14) — measured from accumulated bank memory along
     the predicted own path, then inset for hull beam and safety margin.
     -------------------------------------------------------------------- */
  WorldModel.prototype.computeCorridor = function () {
    const own = this.ownVessel, sv = this.sweptVolume;
    if (!own || !sv) return null;
    const halfBeam = own.dimensions.beam / 2;
    const margin = CFG.risk.bankMargin;
    const pts = this.staticMap.near(own.position, 780);
    const sections = [];

    /* sample the predicted path and measure to the nearest mapped structure
       on each side, in the local along/across frame of that path point */
    for (let i = 0; i < sv.spine.length; i++) {
      const c = sv.spine[i];
      const h = sv.footprints[i].heading;
      const F = fwd(h), P = port(h);
      let bestPort = 220, bestStbd = 220, nPort = 0, nStbd = 0;
      for (const q of pts) {
        const dx = q.x - c.x, dy = q.y - c.y;
        const along = dx * F.x + dy * F.y;
        if (Math.abs(along) > 16) continue;                    // slab around this station
        const across = dx * P.x + dy * P.y;                     // + = to port
        if (across > 3 && across < bestPort) { bestPort = across; nPort = q.n; }
        if (across < -3 && -across < bestStbd) { bestStbd = -across; nStbd = q.n; }
      }
      const known = (nPort > 0 ? 1 : 0) + (nStbd > 0 ? 1 : 0);
      sections.push({
        centre: { x: c.x, y: c.y }, heading: h, t: c.t,
        portLimit: Math.max(0, bestPort - margin - halfBeam),
        stbdLimit: Math.max(0, bestStbd - margin - halfBeam),
        rawPort: bestPort, rawStbd: bestStbd,
        confidence: known / 2
      });
    }

    /* shrink the corridor where a tracked hazard intrudes */
    for (const e of this.entities) {
      if (e.confidence < 0.3) continue;
      if (e.semanticClass === 'buoy') continue;
      const clearRadius = Math.max(e.dimensions.length, e.dimensions.beam) / 2 +
                          e.positionUncertainty + CFG.risk.safetyMargin;
      for (const sec of sections) {
        const F = fwd(sec.heading), P = port(sec.heading);
        const dx = e.position.x - sec.centre.x, dy = e.position.y - sec.centre.y;
        const along = dx * F.x + dy * F.y;
        if (Math.abs(along) > 26) continue;
        const across = dx * P.x + dy * P.y;
        if (across > 0) sec.portLimit = Math.min(sec.portLimit, Math.max(0, across - clearRadius));
        else sec.stbdLimit = Math.min(sec.stbdLimit, Math.max(0, -across - clearRadius));
      }
    }

    /* Smooth the boundary. Per-station minima measured from a sparse point
       map are noisy, and a jagged corridor both looks wrong and produces
       jittery width readings. Erode first (take the local minimum) so the
       smoothing can never claim space that was not measured, then average. */
    const erode = (key) => {
      const raw = sections.map((s) => s[key]);
      const min3 = raw.map((_, i) =>
        Math.min(raw[Math.max(0, i - 1)], raw[i], raw[Math.min(raw.length - 1, i + 1)]));
      return min3.map((_, i) => {
        let sum = 0, n = 0;
        for (let k = -2; k <= 2; k++) {
          const j = i + k;
          if (j < 0 || j >= min3.length) continue;
          sum += min3[j]; n++;
        }
        return sum / n;
      });
    };
    const sp = erode('portLimit'), ss = erode('stbdLimit');
    sections.forEach((s, i) => { s.portLimit = sp[i]; s.stbdLimit = ss[i]; });

    const widths = sections.map((s) => s.portLimit + s.stbdLimit);
    return {
      sections,
      minWidth: widths.length ? Math.min.apply(null, widths) : 0,
      widthAhead: widths.length ? widths[Math.min(4, widths.length - 1)] : 0
    };
  };

  /* -----------------------------------------------------------------------
     Risk engine (§18, §19) — CPA/TCPA plus swept-volume conflict, bank
     proximity and bridge clearance. Not distance alone.
     -------------------------------------------------------------------- */
  WorldModel.prototype.assessRisk = function () {
    const own = this.ownVessel, sv = this.sweptVolume;
    this.risks = []; this.alerts = [];
    if (!own || !sv) return;

    const ownVel = own.velocity;

    for (const e of this.entities) {
      const range = V.dist2d(own.position, e.position);
      /* a track too weak or too far to act on does not generate risk, but it
         is still carried in the world model and still drawn */
      if (e.confidence < CFG.risk.minConfidence) { e.riskLevel = 'none'; continue; }
      if (range > CFG.risk.maxRange) { e.riskLevel = 'none'; continue; }
      if (e.semanticClass === 'buoy' || e.semanticClass === 'bridge_pillar') {
        e.riskLevel = range < 30 ? 'low' : 'none';
        continue;
      }
      const r = cpa(own.position, ownVel, e.position, e.velocity);

      /* swept-volume conflict: does our predicted hull footprint overlap
         this entity's predicted footprint at the same time? */
      /* Swept-volume conflict. Both footprints are inflated by their own
         uncertainty, but the inflation is capped: an unbounded ellipse would
         eventually intersect everything and the alert would mean nothing. */
      /* How far ahead this track's motion can honestly be extrapolated. A
         track whose velocity is barely observed cannot support a 60 s
         prediction, and pretending otherwise manufactures conflicts. */
      const velQuality = e.velocityUncertainty / Math.max(e.speed, 0.6);
      const trustHorizon = velQuality > 1.2 ? 10 : velQuality > 0.6 ? 25 : 60;

      let conflict = null;
      for (const f of sv.footprints) {
        if (f.t > trustHorizon) break;
        const ex = e.position.x + e.velocity.x * f.t;
        const ey = e.position.y + e.velocity.y * f.t;
        const grow = clamp(e.positionUncertainty + e.velocityUncertainty * f.t, 0, 8);
        const poly = rectCorners({ x: ex, y: ey, z: 0 }, e.heading,
                                 e.dimensions.length + grow, e.dimensions.beam + grow);
        if (polysOverlap(f.corners, poly)) { conflict = { t: f.t, x: ex, y: ey }; break; }
      }

      /* --- level ------------------------------------------------------- */
      let level = 'none';
      const C = CFG.risk;
      const closing = r.tcpa > 0.2 && r.tcpa < C.mediumTcpa;
      if (closing) {
        if (r.cpa < C.mediumCpa) level = 'low';
        if (r.cpa < C.highCpa && r.tcpa < C.highTcpa) level = 'medium';
        if (r.cpa < C.criticalCpa && r.tcpa < C.criticalTcpa) level = 'high';
      }
      if (conflict) {
        level = conflict.t < 20 ? 'critical' : conflict.t < 40 ? 'high' : 'low';
      }
      /* a moored or drifting object is a hazard to avoid, not a closing threat */
      if (e.speed < 0.6 && level === 'critical' && range > 90) level = 'high';
      /* uncertainty inflates risk: an unsure track is not a safe track */
      if (level === 'low' && e.positionUncertainty > 16 && range < 260) level = 'medium';
      if (e.state === 'PREDICTED' && level === 'low') level = 'medium';
      if (range < 45 && level === 'none') level = 'low';

      e.riskLevel = level;
      if (e.track) e.track.riskLevel = level;

      const rec = {
        entityId: e.id, level, cpa: r.cpa, tcpa: r.tcpa, range,
        conflict, semanticClass: e.semanticClass, confidence: e.confidence
      };
      this.risks.push(rec);

      if ((level === 'medium' || level === 'high' || level === 'critical')) {
        this.alerts.push({
          level,
          text: conflict
            ? `${e.id} — predicted conflict in ${conflict.t.toFixed(1)} s`
            : `${e.id} — CPA ${r.cpa.toFixed(0)} m / TCPA ${r.tcpa.toFixed(0)} s`,
          entityId: e.id
        });
      }
    }

    /* --- corridor narrowing --------------------------------------------- */
    if (this.corridor && this.corridor.minWidth < own.dimensions.beam * 1.4) {
      this.alerts.push({
        level: this.corridor.minWidth < own.dimensions.beam ? 'high' : 'medium',
        text: `Navigable corridor narrows to ${this.corridor.minWidth.toFixed(0)} m`,
        entityId: null
      });
    }

    /* --- bridge clearance ------------------------------------------------ */
    const b = this.bridgeEst.state;
    if (b) {
      const range = V.dist2d(own.position, b.position);
      const required = own.dimensions.height + 0.7;      // air draft + freeboard allowance
      b.range = range;
      b.required = required;
      b.passable = b.clearance > required && b.openingWidth > own.dimensions.beam + 6;
      if (range < 620) {
        if (!b.passable) {
          this.alerts.push({ level: 'critical',
            text: `${b.id} — clearance ${b.clearance.toFixed(1)} m below required ${required.toFixed(1)} m`,
            entityId: null });
        } else if (b.clearance - required < 1.5) {
          this.alerts.push({ level: 'medium',
            text: `${b.id} — clearance margin ${(b.clearance - required).toFixed(1)} m`, entityId: null });
        }
      }
    }

    const order = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
    this.alerts.sort((a, b2) => order[a.level] - order[b2.level]);
    /* the operator can act on a handful of things, not twenty */
    const seen = new Set();
    this.alerts = this.alerts.filter((a) => {
      const k = a.entityId || a.text;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).slice(0, 6);
  };

  /* highest risk level currently present */
  WorldModel.prototype.overallRisk = function () {
    const order = ['none', 'low', 'medium', 'high', 'critical'];
    let worst = 0;
    for (const r of this.risks) worst = Math.max(worst, order.indexOf(r.level));
    return order[worst];
  };

  NS.worldmodel = { WorldModel, StaticMap, Occupancy, BridgeEstimator };
})(window.CORNU);
