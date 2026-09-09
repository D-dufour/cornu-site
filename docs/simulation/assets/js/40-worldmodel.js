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
    /* the one command this model issues: how far off the nominal lane to
       aim, and how hard to drive. Written by planAvoidance, read by the helm. */
    this.guidance = {
      lateralDemand: 0, speedFactor: 1, active: false,
      targetId: null, reason: 'lane', level: 'none', bridgeLock: false
    };
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
  WorldModel.prototype.getGuidance = function () { return this.guidance; };

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

    /* 8. decide ------------------------------------------------------------ */
    this.planAvoidance(dt);

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

  /* -----------------------------------------------------------------------
     Avoidance (§20) — the first function in the stack that commits.

     Everything above observes. This decides, and what it decides the helm
     executes. It emits one number — metres to port of the nominal
     keep-right lane — plus an engine order.

     Two things make this harder than it reads.

     The frame. A hazard 400 m ahead in a channel that meanders is not
     where a straight line out of the bow says it is; on this waterway the
     bend alone is worth tens of metres, enough to place a vessel dead
     ahead somewhere off the port bow and have the geometry come out
     backwards. So clearances are measured across the predicted path, the
     same frame the corridor is measured in, not across the compass.

     The commitment. A vessel met head-on sweeps from fine on the bow to
     abeam to astern, and its bearing crosses the centreline while it does;
     meanwhile the tracker may re-number it twice on the way past. Deciding
     again on every update means altering to starboard, then to port, then
     to starboard, and a hull this size simply oscillates in place. So what
     is owned is the side, not the track: chosen once, held through the
     pass, released a few seconds after the last hazard needs it.
     -------------------------------------------------------------------- */
  WorldModel.prototype.planAvoidance = function (dt) {
    const own = this.ownVessel, G = this.guidance;
    if (!own) return;

    const F = fwd(own.heading), Pt = port(own.heading);
    const ownLen = own.dimensions.length, halfBeam = own.dimensions.beam / 2;
    const RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
    const byId = new Map();
    for (const e of this.entities) byId.set(e.id, e);

    /* --- where a hazard sits relative to the path we intend to follow --- */
    const spine = this.sweptVolume ? this.sweptVolume.footprints : null;
    const frameOf = (p) => {
      if (!spine || !spine.length) {
        const dx = p.x - own.position.x, dy = p.y - own.position.y;
        return { along: dx * F.x + dy * F.y, across: dx * Pt.x + dy * Pt.y };
      }
      let bi = 0, bd = Infinity;
      for (let i = 0; i < spine.length; i++) {
        const ex = spine[i].centre.x - p.x, ey = spine[i].centre.y - p.y;
        const d = ex * ex + ey * ey;
        if (d < bd) { bd = d; bi = i; }
      }
      const fp = spine[bi];
      const Ff = fwd(fp.heading), Pf = port(fp.heading);
      const dx = p.x - fp.centre.x, dy = p.y - fp.centre.y;
      return {
        along: fp.t * Math.max(own.speed, 0.5) + dx * Ff.x + dy * Ff.y,
        across: dx * Pf.x + dy * Pf.y
      };
    };

    /* the lateral half-extent of an oriented hull — a vessel lying parallel
       to us is as wide as its beam, not as wide as its length */
    const halfAcross = (e) => {
      const rel = wrapPi(e.heading - own.heading);
      return Math.abs(Math.cos(rel)) * e.dimensions.beam / 2 +
             Math.abs(Math.sin(rel)) * e.dimensions.length / 2;
    };
    /* What counts as too close to accept. Deliberately tighter than the
       corridor's own margin: the corridor is the water the vessel would
       like, this is the water it will alter course to get. Using the wider
       figure here puts the helm in a permanent manoeuvre on a waterway this
       busy, and a warning that is always on is not a warning. */
    const clearanceFor = (e) => halfBeam + halfAcross(e) +
                                CFG.risk.safetyMargin * 0.6 +
                                Math.min(e.positionUncertainty, 8);
    /* the rate the gap is actually shutting — a vessel met head-on arrives
       at the sum of both speeds, not at ours */
    const closingOn = (e) =>
      Math.max(own.speed - (e.velocity.x * F.x + e.velocity.y * F.y), 0.8);

    /* --- 0. how much water there is either side --------------------------
       Bounded by the mapped shoreline, not by the hazard-shrunk corridor:
       the corridor narrows around every tracked object, and those are
       answered by the repulsion term below, so clamping to it as well would
       double-count them and feed its per-station noise into the helm. */
    const cor = this.corridor;
    if (cor && cor.sections.length) {
      const sec = cor.sections[Math.min(5, cor.sections.length - 1)];
      const margin = CFG.risk.bankMargin + halfBeam;
      const rawP = Math.max(0, Math.min(sec.rawPort, 220) - margin);
      const rawS = Math.max(0, Math.min(sec.rawStbd, 220) - margin);
      const k = clamp(dt * 1.4, 0, 1);
      if (!this._corLim) this._corLim = { port: rawP, stbd: rawS };
      this._corLim.port += (rawP - this._corLim.port) * k;
      this._corLim.stbd += (rawS - this._corLim.stbd) * k;
    }
    const roomPort = this._corLim ? this._corLim.port : 60;
    const roomStbd = this._corLim ? this._corLim.stbd : 60;

    /* Room is not a property of where we are, it is a property of where the
       meeting happens. A starboard alteration that has room here and none
       alongside the quay four hundred metres up is not a plan. The corridor
       already measures both banks along the whole predicted path, so the
       side is chosen against the water that will actually be there. */
    const bankMargin = CFG.risk.bankMargin + halfBeam;
    const roomAt = (along) => {
      if (!cor || !cor.sections.length) return { port: roomPort, stbd: roomStbd };
      const speed = Math.max(own.speed, 0.5);
      let bi = 0, bd = Infinity;
      for (let i = 0; i < cor.sections.length; i++) {
        const d = Math.abs(cor.sections[i].t * speed - along);
        if (d < bd) { bd = d; bi = i; }
      }
      /* the tightest point between here and there is what governs */
      let p = Infinity, st = Infinity;
      for (let i = 0; i <= bi; i++) {
        p = Math.min(p, Math.min(cor.sections[i].rawPort, 220));
        st = Math.min(st, Math.min(cor.sections[i].rawStbd, 220));
      }
      return { port: Math.max(0, p - bankMargin), stbd: Math.max(0, st - bankMargin) };
    };

    /* --- 1. the hazard that governs, if there is one --------------------- */
    let best = null;
    for (const r of this.risks) {
      if (RANK[r.level] < 2 && !r.conflict) continue;
      const e = byId.get(r.entityId);
      if (!e || e.semanticClass === 'buoy') continue;

      const fr = frameOf(e.position);
      /* only what is still ahead of the bow can be steered around; once a
         hazard is abeam, altering course swings the stern into it */
      /* The across measurement is only meaningful where there is a predicted
         path to measure it against. Past the end of the swept volume the
         frame is an extrapolated straight line down a channel that bends,
         and a vessel dead ahead can come out tens of metres off the bow. So
         the decision waits until the hazard is inside the horizon the model
         can actually reason in. */
      const horizon = spine && spine.length
        ? spine[spine.length - 1].t * Math.max(own.speed, 0.5) + 60 : 400;
      if (fr.along < ownLen * 0.6 || fr.along > horizon) continue;

      const need = clearanceFor(e);
      const shortfall = need - Math.abs(fr.across);
      if (shortfall <= 3) continue;                        // passing clear already

      const rank = RANK[r.level] + (r.conflict ? 1 : 0);
      const score = rank * 1000 - fr.along;                // worst first, then nearest
      if (!best || score > best.score) {
        best = {
          id: e.id, e, fr, need, magnitude: shortfall, score,
          level: r.level, rank, closing: closingOn(e)
        };
      }
    }

    /* --- 2. own the side, not the track ---------------------------------- */
    let C2 = this._commit;
    if (best) {
      if (!C2 || C2.hold <= 0) {
        /* Rule of the road first: alter to starboard, unless the hazard is
           plainly on the starboard bow and the shorter way round is to
           port. The dead band keeps a bearing near dead-ahead from picking
           a side twice running.

           Then the bank has a say. A vessel met head-on while it runs on
           our side of the channel cannot always be cleared to starboard —
           there may not be that much water there — while the full width of
           the channel lies open to port. On inland waterways that case is
           not a violation but a signal: the blue board, agreeing a
           starboard-to-starboard pass. A side that cannot achieve the
           clearance yields to one that can. */
        let side = best.fr.across < -8 ? 1 : -1;             // +1 = to port
        const rm = roomAt(best.fr.along);
        const roomOn = (sd) => (sd > 0 ? rm.port : rm.stbd);
        if (roomOn(side) < best.magnitude && roomOn(-side) > roomOn(side) + 8) side = -side;
        C2 = { side, hold: 0, magnitude: 0, targetId: null, level: 'none', flipped: false };
      }
      /* One reconsideration, while there is still distance to use it. The
         model can be wrong about the room the first time — a bank it has
         not mapped yet, a hazard whose size it has revised — but a helm
         that changes its mind twice has no plan at all. */
      if (!C2.flipped && !C2.passing && best.fr.along > 170) {
        const rm = roomAt(best.fr.along);
        const here = C2.side > 0 ? rm.port : rm.stbd;
        const other = C2.side > 0 ? rm.stbd : rm.port;
        if (here < best.magnitude - 4 && other > here * 1.8 + 10) {
          C2.side = -C2.side;
          C2.flipped = true;
        }
      }
      C2.hold = 6;                                           // s, refreshed while needed
      C2.magnitude = best.magnitude;
      C2.targetId = best.id;
      C2.level = best.level;
      C2.along = best.fr.along;
      C2.closing = best.closing;
      C2.passing = false;
    } else if (C2) {
      /* nothing ahead needs it any more — hold the offset while the last
         one goes down the side, then give it back */
      C2.hold -= dt;
      C2.passing = true;
      if (C2.hold <= 0) C2 = null;
    }
    this._commit = C2;

    /* --- 3. turn it into an order ---------------------------------------- */
    let demand = 0, speed = 1;
    let targetId = null, reason = 'lane', level = 'none';

    if (C2) {
      /* How early to commit is the whole question. Waiting until a hazard
         looks near means altering with no water left to alter into, and
         making the alteration early and obviously is what the rules ask
         for anyway. */
      let urgency = 1;
      if (!C2.passing) {
        const ttg = Math.max(C2.along, 0) / (C2.closing || Math.max(own.speed, 1));
        urgency = clamp(1 - (ttg - 30) / 40, 0.65, 1);
      }
      demand = C2.magnitude * C2.side * urgency;
      targetId = C2.targetId; reason = 'avoiding'; level = C2.level;
      if (C2.level === 'critical') speed = 0.68;
      else if (C2.level === 'high') speed = 0.82;
    }

    /* --- 4. line up on the bridge opening -------------------------------- */
    let bridgeLock = false;
    const b = this.bridgeEst.state;
    if (b && b.range !== undefined && b.range < 480 && b.confidence > 0.35) {
      const bp = port(b.heading);
      const oc = {
        x: b.position.x - bp.x * b.openingOffset,
        y: b.position.y - bp.y * b.openingOffset, z: 0
      };
      const fr = frameOf(oc);
      const blend = clamp(1 - (b.range - 100) / 320, 0, 1);
      const aim = fr.across * blend;
      bridgeLock = blend > 0.15;
      /* the opening wins only when nothing is actively being avoided */
      if (!C2 && Math.abs(aim) > 0.5) {
        demand = aim; targetId = b.id; reason = 'bridge';
        level = b.passable ? 'low' : 'high';
      }
      if (b.range < 300) speed = Math.min(speed, b.passable ? 0.88 : 0.32);
    }

    /* --- 5. never steer into a bank -------------------------------------- */
    if (this._corLim) {
      const bounded = clamp(demand, -roomStbd, roomPort);
      /* Being trimmed by a metre or two is just the bank being where it is.
         Only a shortfall large enough to matter is a predicament worth
         reporting and worth taking way off for. */
      if (Math.abs(bounded) < Math.abs(demand) - 6 && reason === 'avoiding') {
        /* The bank will not give us the room the hazard needs. Course alone
           cannot solve this meeting, so the other lever comes in: take the
           way off. Slowing buys the seconds steering could not, and a
           shortfall the model cannot steer out of is worth saying so. */
        reason = 'constrained';
        /* Steering has run out of water. The other lever is speed, and it is
           not a token reduction: a meeting that cannot be cleared by course
           is cleared by arriving later, or by not arriving at all until the
           other vessel is past. */
        const shortBy = Math.abs(demand) - Math.abs(bounded);
        speed = Math.min(speed, clamp(1 - shortBy / 30, 0.5, 0.92));
      }
      demand = bounded;
      if (cor && cor.minWidth < own.dimensions.beam * 2.4) speed = Math.min(speed, 0.75);
    }

    /* --- 6. rate-limit, so the order is a manoeuvre and not a twitch ----- */
    const step = Math.max(dt, 1e-3);
    G.lateralDemand += clamp(demand - G.lateralDemand, -6 * step, 6 * step);
    G.speedFactor += clamp(speed - G.speedFactor, -0.7 * step, 0.3 * step);
    G.speedFactor = clamp(G.speedFactor, 0.42, 1);
    G.active = Math.abs(G.lateralDemand) > 2.5 || G.speedFactor < 0.95;
    G.targetId = targetId;
    G.reason = reason;
    G.level = level;
    G.bridgeLock = bridgeLock;
    G.phase = C2 ? (C2.passing ? 'passing' : 'approach') : '—';
    /* A waterway this busy means the vessel is nearly always shifting over
       for something, and a readout that says AVOIDING all day says nothing.
       A routine shift for a vessel being met is not the same event as a
       manoeuvre driven by a predicted conflict, so they are not given the
       same word. */
    G.grade = reason === 'lane' ? 'lane'
      : reason === 'bridge' ? 'bridge'
      : reason === 'constrained' ? 'constrained'
      : (level === 'high' || level === 'critical' || Math.abs(G.lateralDemand) > 14)
        ? 'avoiding' : 'keeping clear';

    if (G.active && reason !== 'lane' && G.grade !== 'keeping clear') {
      const sideName = G.lateralDemand >= 0 ? 'port' : 'starboard';
      const mag = Math.abs(G.lateralDemand).toFixed(0);
      const slow = G.speedFactor < 0.95
        ? ', ' + (G.speedFactor * 100).toFixed(0) + '% speed' : '';
      this.alerts.unshift({
        level: reason === 'bridge' ? 'low' : (level === 'none' ? 'medium' : level),
        text: reason === 'bridge'
          ? 'Lining up on ' + targetId + ' opening — ' + mag + ' m to ' + sideName
          : (reason === 'constrained'
              ? 'Avoiding ' + targetId + ' — ' + mag + ' m to ' + sideName +
                ', bank-limited' + slow
              : 'Avoiding ' + targetId + ' — ' + mag + ' m to ' + sideName + slow),
        entityId: targetId, guidance: true
      });
      this.alerts = this.alerts.slice(0, 6);
    }
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
