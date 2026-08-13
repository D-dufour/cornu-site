/* =============================================================================
   30-tracking.js — ASSOCIATION → TRACKING → FUSION.

   DETECTION → ASSOCIATION → TRACK CREATION → STATE UPDATE → PERSISTENCE

   Position/velocity: linear Kalman filter, constant-velocity (01-math.js).
   Classification:    per-class log-odds accumulated across sensors, softmaxed.
   Persistence:       confidence decays when unobserved; the track coasts on
                      dead reckoning and is only deleted once confidence
                      collapses (§27 semantic memory).
   ========================================================================== */
(function (NS) {
  'use strict';
  const { KF, V, clamp, sigmoid } = NS.math;
  const CFG = NS.CFG;

  /* dimension priors by semantic class. A production system would estimate
     extent from LiDAR cluster geometry; here the class posterior drives a
     prior, which is why dims carry their own confidence. */
  const DIM_PRIOR = {
    vessel:            { length: 85, beam: 11, height: 7 },
    small_craft:       { length: 9,  beam: 3,  height: 2.4 },
    floating_obstacle: { length: 4,  beam: 2.6, height: 1 },
    buoy:              { length: 2.2, beam: 2.2, height: 2.6 },
    bridge_pillar:     { length: 9,  beam: 7,  height: 12 },
    quay:              { length: 40, beam: 6,  height: 4 },
    unknown:           { length: 6,  beam: 4,  height: 2 }
  };

  let trackSeq = 0;
  /* The numeric identity is issued once, when the track is created, and is
     kept for the life of the track. Only the stem changes as the classifier
     firms up, so the operator sees UNKNOWN_012 become VESSEL_012 — the same
     object, now named (§42). */
  function stemFor(cls) {
    const stem = cls === 'vessel' ? 'VESSEL'
      : cls === 'small_craft' ? 'CRAFT'
      : cls === 'buoy' ? 'BUOY'
      : cls === 'bridge_pillar' ? 'PILLAR'
      : cls === 'floating_obstacle' ? 'OBSTACLE'
      : 'UNKNOWN';
    return stem;
  }

  function Track(obs, now) {
    const vx = obs.velocityEstimate ? obs.velocityEstimate.x : 0;
    const vy = obs.velocityEstimate ? obs.velocityEstimate.y : 0;
    this.kf = new KF(obs.estimatedPosition.x, obs.estimatedPosition.y, vx, vy, CFG.tracking);
    this.classScores = {};
    CFG.classes.forEach((c) => { this.classScores[c] = 0; });
    this.classScores.unknown = 0.4;              // mild prior toward "not yet known"

    this.firstObserved = now;
    this.lastObserved = now;
    this.observationCount = 0;
    this.contributingSensors = {};
    this.confidence = 0.22;
    this.state = 'TENTATIVE';                    // TENTATIVE | TRACKED | PREDICTED
    this.history = [];
    this.num = String(++trackSeq).padStart(3, '0');
    this.id = null;                              // named once the class is confident
    this.provisionalId = 'UNKNOWN_' + this.num;
    this.heading = 0;
    this.riskLevel = 'none';
    this.ingest(obs, now);
  }

  Track.prototype.semanticClass = function () {
    let best = 'unknown', bestV = -Infinity;
    for (const c of CFG.classes) {
      if (this.classScores[c] > bestV) { bestV = this.classScores[c]; best = c; }
    }
    return best;
  };
  /* softmax posterior over the class scores */
  Track.prototype.classProbability = function (cls) {
    let sum = 0;
    for (const c of CFG.classes) sum += Math.exp(this.classScores[c]);
    return Math.exp(this.classScores[cls || this.semanticClass()]) / (sum || 1);
  };

  Track.prototype.ingest = function (obs, now) {
    /* --- position update ------------------------------------------------ */
    this.kf.updatePosition(obs.estimatedPosition.x, obs.estimatedPosition.y, obs.covariance);

    /* --- Doppler: constrains velocity along the bearing ------------------
       The measurement is a range rate relative to the moving sensor. The KF
       state is an absolute world velocity, so add the sensor's own radial
       component back in:  v_target·u = ṙ_relative + v_sensor·u             */
    if (obs.radialVelocity !== undefined && obs.radialUnit) {
      const u = obs.radialUnit;
      const sv = obs.sensorVelocity || { x: 0, y: 0 };
      const absoluteRangeRate = obs.radialVelocity + (sv.x * u.x + sv.y * u.y);
      this.kf.updateRadial(absoluteRangeRate, u.x, u.y, 0.35);
    }
    /* --- AIS declares a full velocity vector ----------------------------- */
    if (obs.velocityEstimate) {
      const w = 0.35;
      this.kf.x[2][0] += (obs.velocityEstimate.x - this.kf.x[2][0]) * w;
      this.kf.x[3][0] += (obs.velocityEstimate.y - this.kf.x[3][0]) * w;
      this.kf.P[2][2] *= (1 - w * 0.8);
      this.kf.P[3][3] *= (1 - w * 0.8);
    }

    /* --- classification: accumulate log-odds evidence -------------------- */
    if (obs.classification) {
      const conf = clamp(obs.classificationConfidence || 0.3, 0.02, 0.97);
      const evidence = Math.log(conf / (1 - conf));
      /* an independent sensor tier is worth more than another frame of the same one */
      const weight = this.contributingSensors[obs.sensorId] ? 0.22 : 0.55;
      const c = obs.classification;
      if (this.classScores[c] === undefined) this.classScores[c] = 0;
      this.classScores[c] += evidence * weight;
      /* mild decay of competing hypotheses keeps scores bounded */
      for (const k of CFG.classes) if (k !== c) this.classScores[k] *= 0.985;
    }

    this.contributingSensors[obs.sensorId] = now;
    this.observationCount++;
    this.lastObserved = now;
    this.confidence = clamp(this.confidence + CFG.tracking.confidenceGainPerObs *
      (1 - this.confidence), 0, 0.995);

    if (this.state !== 'TRACKED' && this.observationCount >= CFG.tracking.confirmObservations) {
      this.state = 'TRACKED';
    }
    /* Identity is issued once the classifier is confident enough to name the
       thing. Until then the track carries its provisional UNKNOWN_nnn id, and
       the operator can see that CORNU has a contact but not yet an identity. */
    if (this.state === 'TRACKED' && !this.idFixed) {
      const c = this.semanticClass();
      if (c !== 'unknown' && this.classProbability(c) > 0.5) {
        this.id = stemFor(c) + '_' + this.num;     // same number, now named
        this.idFixed = true;
      }
    }
  };

  Track.prototype.predict = function (dt, now) {
    this.kf.predict(dt);
    const v = this.kf.vel();
    if (V.len2d(v) > 0.4) this.heading = Math.atan2(v.x, v.y);
    const age = now - this.lastObserved;
    if (age > CFG.tracking.predictedAfterSec && this.state === 'TRACKED') this.state = 'PREDICTED';
    if (age > 0.2) {
      this.confidence -= CFG.tracking.confidenceDecayPerSec * dt;
      this.confidence = clamp(this.confidence, 0, 1);
    }
  };

  Track.prototype.pushHistory = function (now) {
    const p = this.kf.pos();
    const last = this.history[this.history.length - 1];
    if (!last || V.dist2d(last, p) > 3) {
      this.history.push({ x: p.x, y: p.y, t: now });
      if (this.history.length > 90) this.history.shift();
    }
  };

  /* Dimensions follow the class posterior — but only once the classifier is
     actually confident. An unsure track must not be drawn, or reasoned about,
     as an 85 m cargo vessel. */
  Track.prototype.dims = function () {
    const c = this.semanticClass();
    const p = this.classProbability(c);
    if (p < CFG.tracking.classDimsThreshold) return Object.assign({}, DIM_PRIOR.unknown);
    const base = DIM_PRIOR[c] || DIM_PRIOR.unknown;
    /* blend from the neutral prior toward the class prior as belief firms up */
    const w = clamp((p - CFG.tracking.classDimsThreshold) / (1 - CFG.tracking.classDimsThreshold), 0, 1);
    const u = DIM_PRIOR.unknown;
    return {
      length: u.length + (base.length - u.length) * w,
      beam:   u.beam   + (base.beam   - u.beam)   * w,
      height: u.height + (base.height - u.height) * w
    };
  };

  /* absorb `other` into this track (duplicate resolution) */
  Track.prototype.absorb = function (other) {
    for (const k in other.classScores) {
      this.classScores[k] = (this.classScores[k] || 0) + other.classScores[k] * 0.5;
    }
    for (const s in other.contributingSensors) {
      if (!this.contributingSensors[s]) this.contributingSensors[s] = other.contributingSensors[s];
    }
    this.observationCount += other.observationCount;
    this.firstObserved = Math.min(this.firstObserved, other.firstObserved);
    this.lastObserved = Math.max(this.lastObserved, other.lastObserved);
    this.confidence = Math.max(this.confidence, other.confidence);
    /* inherit an established identity rather than discarding it */
    if (!this.idFixed && other.idFixed) { this.id = other.id; this.num = other.num; this.idFixed = true; }
  };

  /* Export as the WorldEntity shape of §9 */
  Track.prototype.toEntity = function (now) {
    const p = this.kf.pos(), v = this.kf.vel();
    return {
      id: this.id || this.provisionalId,
      semanticClass: this.semanticClass(),
      classConfidence: this.classProbability(),
      position: p,
      heading: this.heading,
      dimensions: this.dims(),
      velocity: v,
      speed: V.len2d(v),
      confidence: this.confidence,
      positionUncertainty: this.kf.posSigma(),
      velocityUncertainty: this.kf.velSigma(),
      ellipse: this.kf.posEllipse(),
      firstObserved: this.firstObserved,
      lastObserved: this.lastObserved,
      ageSeconds: now - this.firstObserved,
      staleSeconds: now - this.lastObserved,
      observationCount: this.observationCount,
      contributingSensors: Object.keys(this.contributingSensors),
      state: this.state,
      history: this.history,
      riskLevel: this.riskLevel,
      track: this
    };
  };

  /* ---------------------------------------------------------------------
     Tracker — global nearest-neighbour association with a Mahalanobis gate.
     Greedy by ascending distance; one observation per track per cycle.
     ------------------------------------------------------------------ */
  function Tracker() { this.tracks = []; }

  Tracker.prototype.update = function (observations, dt, now) {
    /* 1. predict every track forward */
    for (const t of this.tracks) t.predict(dt, now);

    /* 2. build candidate pairings inside the gate */
    const pairs = [];
    for (let oi = 0; oi < observations.length; oi++) {
      const o = observations[oi];
      for (let ti = 0; ti < this.tracks.length; ti++) {
        const t = this.tracks[ti];
        const euclid = V.dist2d(t.kf.pos(), o.estimatedPosition);
        if (euclid > CFG.tracking.gateMaxMetres) continue;
        const d2 = t.kf.mahalanobis2(o.estimatedPosition.x, o.estimatedPosition.y, o.covariance);
        if (d2 > CFG.tracking.gateMahalanobis * CFG.tracking.gateMahalanobis) continue;
        pairs.push({ oi, ti, d2 });
      }
    }
    pairs.sort((a, b) => a.d2 - b.d2);

    const usedObs = new Set(), usedTrk = new Set();
    for (const p of pairs) {
      if (usedObs.has(p.oi) || usedTrk.has(p.ti)) continue;
      usedObs.add(p.oi); usedTrk.add(p.ti);
      this.tracks[p.ti].ingest(observations[p.oi], now);
    }

    /* 3. unmatched observations spawn tentative tracks --------------------
          Guard against spawning a duplicate on top of an existing track:
          the gate above may have rejected it on covariance alone.        */
    for (let oi = 0; oi < observations.length; oi++) {
      if (usedObs.has(oi)) continue;
      const o = observations[oi];
      let tooClose = false;
      for (const t of this.tracks) {
        /* suppression radius scales with how uncertain the existing track is:
           a fuzzy far-range track legitimately owns a wider region */
        const r = CFG.tracking.spawnSuppression + t.kf.posSigma() * 1.6;
        if (V.dist2d(t.kf.pos(), o.estimatedPosition) < r) { tooClose = true; break; }
      }
      if (tooClose) continue;
      this.tracks.push(new Track(o, now));
    }

    /* 4. persistence and deletion ---------------------------------------- */
    this.tracks = this.tracks.filter((t) => {
      const stale = now - t.lastObserved;
      if (stale > CFG.tracking.maxCoastSec) return false;
      if (t.confidence < CFG.tracking.dropConfidence && t.state !== 'TENTATIVE') return false;
      if (t.state === 'TENTATIVE' && stale > 3.5) return false;
      return true;
    });

    this.mergeDuplicates();
    for (const t of this.tracks) t.pushHistory(now);
    return this.tracks;
  };

  /* -----------------------------------------------------------------------
     Duplicate resolution. Independent sensors with different biases can open
     two tracks on one object. Where two tracks sit close together AND agree
     on velocity, they are the same thing; keep the better-observed one.
     -------------------------------------------------------------------- */
  Tracker.prototype.mergeDuplicates = function () {
    const drop = new Set();
    for (let i = 0; i < this.tracks.length; i++) {
      if (drop.has(i)) continue;
      const a = this.tracks[i];
      for (let j = i + 1; j < this.tracks.length; j++) {
        if (drop.has(j)) continue;
        const b = this.tracks[j];
        const d = V.dist2d(a.kf.pos(), b.kf.pos());
        const limit = CFG.tracking.mergeDistance + (a.kf.posSigma() + b.kf.posSigma()) * 0.5;
        if (d > limit) continue;
        const va = a.kf.vel(), vb = b.kf.vel();
        if (Math.hypot(va.x - vb.x, va.y - vb.y) > CFG.tracking.mergeSpeedDelta) continue;
        /* keep whichever track has seen more evidence */
        const keep = a.observationCount >= b.observationCount ? a : b;
        const lose = keep === a ? b : a;
        keep.absorb(lose);
        drop.add(keep === a ? j : i);
        if (keep !== a) break;
      }
    }
    if (drop.size) this.tracks = this.tracks.filter((_, i) => !drop.has(i));
  };

  NS.tracking = { Tracker, Track, DIM_PRIOR };
})(window.CORNU);
