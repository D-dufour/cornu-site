/* =============================================================================
   10-world.js — GROUND TRUTH ONLY.

   Nothing in this file may be read by the world model, the renderer's
   world-model view, or the risk engine. It exists so the sensors have
   something to observe, and so the "Ground truth" overlay can show the
   operator what CORNU is being scored against.
   ========================================================================== */
(function (NS) {
  'use strict';
  const { V, fwd, port, clamp, lerp, rectCorners } = NS.math;
  const CFG = NS.CFG;

  /* ---------------------------------------------------------------------
     Waterway — a curving channel described by a sampled centreline.
     Station s runs from 0 at the southern end to `length` at the north.
     ------------------------------------------------------------------ */
  function Waterway(cfg) {
    this.length = cfg.length;
    this.stations = [];
    const n = cfg.stations;
    for (let i = 0; i <= n; i++) {
      const s = (i / n) * cfg.length;
      /* two superimposed sinusoids give a river-like meander rather than an arc */
      const x = 96 * Math.sin(s / 470) + 34 * Math.sin(s / 205 + 1.1);
      const y = s;
      const halfWidth = cfg.baseHalfWidth + 13 * Math.sin(s / 320 + 0.6) + 7 * Math.sin(s / 118);
      this.stations.push({ s, p: { x, y, z: 0 }, halfWidth });
    }
    /* tangents / normals by central difference */
    for (let i = 0; i <= n; i++) {
      const a = this.stations[Math.max(0, i - 1)].p;
      const b = this.stations[Math.min(n, i + 1)].p;
      const t = V.norm({ x: b.x - a.x, y: b.y - a.y, z: 0 });
      this.stations[i].tangent = t;
      this.stations[i].normal = { x: -t.y, y: t.x, z: 0 };   // points to port of travel
      this.stations[i].heading = Math.atan2(t.x, t.y);
    }
  }
  /* interpolate the channel at an arbitrary station */
  Waterway.prototype.at = function (s) {
    const n = this.stations.length - 1;
    const f = clamp(s / this.length, 0, 1) * n;
    const i = Math.min(n - 1, Math.floor(f)), t = f - i;
    const A = this.stations[i], B = this.stations[i + 1];
    return {
      s,
      p: { x: lerp(A.p.x, B.p.x, t), y: lerp(A.p.y, B.p.y, t), z: 0 },
      tangent: V.norm({ x: lerp(A.tangent.x, B.tangent.x, t), y: lerp(A.tangent.y, B.tangent.y, t), z: 0 }),
      normal: V.norm({ x: lerp(A.normal.x, B.normal.x, t), y: lerp(A.normal.y, B.normal.y, t), z: 0 }),
      halfWidth: lerp(A.halfWidth, B.halfWidth, t),
      heading: Math.atan2(lerp(A.tangent.x, B.tangent.x, t), lerp(A.tangent.y, B.tangent.y, t))
    };
  };
  /* point on the channel offset to starboard (negative = port) */
  Waterway.prototype.point = function (s, offset) {
    const a = this.at(s);
    return { x: a.p.x - a.normal.x * offset, y: a.p.y - a.normal.y * offset, z: 0 };
  };
  /* nearest station to a world point — coarse scan then refine */
  Waterway.prototype.project = function (pt) {
    let best = 0, bestD = Infinity;
    for (const st of this.stations) {
      const d = (st.p.x - pt.x) ** 2 + (st.p.y - pt.y) ** 2;
      if (d < bestD) { bestD = d; best = st.s; }
    }
    for (let s = best - 20; s <= best + 20; s += 2) {
      const a = this.at(s);
      const d = (a.p.x - pt.x) ** 2 + (a.p.y - pt.y) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    const a = this.at(best);
    const off = -((pt.x - a.p.x) * a.normal.x + (pt.y - a.p.y) * a.normal.y);
    return { s: best, offset: off };
  };

  /* ---------------------------------------------------------------------
     Ground-truth entities
     ------------------------------------------------------------------ */
  let seq = 0;
  function GtEntity(o) {
    Object.assign(this, {
      id: o.id || ('GT_' + (++seq)),
      cls: o.cls,
      position: o.position,
      heading: o.heading || 0,
      velocity: o.velocity || V.make(0, 0, 0),
      dims: o.dims,                 // {length, beam, height}
      radarCrossSection: o.rcs !== undefined ? o.rcs : 1,
      visualSize: o.visualSize !== undefined ? o.visualSize : 1,
      static: !!o.static,
      agent: o.agent || null,
      transmitsAis: !!o.transmitsAis,
      label: o.label || o.cls
    });
  }
  GtEntity.prototype.footprint = function () {
    return rectCorners(this.position, this.heading, this.dims.length, this.dims.beam);
  };

  /* ---------------------------------------------------------------------
     Traffic agent — follows the channel at a station/offset, optionally
     executing a scripted lateral manoeuvre.
     ------------------------------------------------------------------ */
  function TrafficAgent(o) {
    Object.assign(this, {
      s: o.s, offset: o.offset, speed: o.speed, dir: o.dir || 1,
      targetOffset: o.offset, drift: o.drift || 0, script: o.script || null
    });
  }
  TrafficAgent.prototype.step = function (dt, world, t) {
    if (this.script) this.script(this, dt, world, t);
    this.s += this.speed * this.dir * dt;
    if (this.s > world.waterway.length + 250) this.s = -220;
    if (this.s < -250) this.s = world.waterway.length + 220;
    this.offset += clamp(this.targetOffset - this.offset, -6 * dt, 6 * dt);
    this.offset += this.drift * dt;
  };
  TrafficAgent.prototype.apply = function (ent, world) {
    const a = world.waterway.at(clamp(this.s, 0, world.waterway.length));
    const p = { x: a.p.x - a.normal.x * this.offset, y: a.p.y - a.normal.y * this.offset, z: 0 };
    const prev = ent.position;
    ent.position = p;
    ent.heading = this.dir > 0 ? a.heading : a.heading + Math.PI;
    const F = fwd(ent.heading);
    ent.velocity = { x: F.x * this.speed, y: F.y * this.speed, z: 0 };
    void prev;
  };

  /* ---------------------------------------------------------------------
     Own vessel — a 100 m hull with helm dynamics, not a point.
     ------------------------------------------------------------------ */
  function OwnShip(world, cfg) {
    const s0 = world.startStation !== undefined ? world.startStation : 60;
    const start = world.waterway.point(s0, cfg.laneOffset);
    this.position = start;
    this.heading = world.waterway.at(s0).heading;
    this.speed = cfg.cruiseSpeed;
    this.yawRate = 0;
    this.dims = { length: cfg.length, beam: cfg.beam, height: cfg.airDraft };
    this.cfg = cfg;
    this.stationEstimate = s0;
    /* set every frame by the world model — the helm never decides anything
       itself, it only executes. Null until the first model update lands. */
    this.guidance = null;
    this.commandedOffset = cfg.laneOffset;
  }
  OwnShip.prototype.step = function (dt, world) {
    const c = this.cfg;
    /* helm: steer toward a lookahead point on the commanded lane.

       The nominal lane is keep-right. The world model can order the aim
       point off that lane to clear a hazard or to line up on a bridge
       opening; `lateralDemand` is metres to port, and waterway offsets are
       measured to starboard, so it is subtracted. */
    const here = world.waterway.project(this.position);
    this.stationEstimate = here.s;

    const g = this.guidance;
    const wantOffset = c.laneOffset - (g ? g.lateralDemand : 0);
    /* ease the commanded offset so a new order is a manoeuvre, not a jump */
    this.commandedOffset += (wantOffset - this.commandedOffset) * clamp(dt * 2.4, 0, 1);

    /* How hard the helm works is set by how far off the ordered track we
       actually are, not by how large the order was. Pure pursuit converges
       on a long lookahead only asymptotically; pulling the aim point in is
       what turns a standing order into a visible alteration of course. */
    const crossErr = this.commandedOffset - here.offset;
    const urgency = clamp(Math.abs(crossErr) / 20, 0, 1);
    const look = c.lookahead * (1 - urgency * 0.62);
    const maxYaw = c.maxYawRate * (1 + urgency * 0.85);

    const target = world.waterway.point(here.s + look, this.commandedOffset);
    const desired = Math.atan2(target.x - this.position.x, target.y - this.position.y);
    let err = NS.math.wrapPi(desired - this.heading);
    const demand = clamp(err * c.helmGain * (1 + urgency * 0.6), -maxYaw, maxYaw);
    this.yawRate += (demand - this.yawRate) * clamp(dt * c.helmDamping, 0, 1);
    this.heading = NS.math.wrapPi(this.heading + this.yawRate * dt);

    /* engine: the model can order a reduction, the hull takes time to lose way */
    const wantSpeed = c.cruiseSpeed * (g ? g.speedFactor : 1);
    this.speed += clamp(wantSpeed - this.speed, -1.1 * dt, 0.45 * dt);

    const F = fwd(this.heading);
    this.position = {
      x: this.position.x + F.x * this.speed * dt,
      y: this.position.y + F.y * this.speed * dt,
      z: 0
    };
    /* loop the run so the demo never ends */
    if (here.s > world.waterway.length - 90) {
      this.position = world.waterway.point(40, c.laneOffset);
      this.heading = world.waterway.at(40).heading;
      this.commandedOffset = c.laneOffset;
      this.speed = c.cruiseSpeed;
      world.onLoop();
    }
  };
  OwnShip.prototype.velocity = function () {
    const F = fwd(this.heading);
    return { x: F.x * this.speed, y: F.y * this.speed, z: 0 };
  };
  OwnShip.prototype.footprint = function () {
    return rectCorners(this.position, this.heading, this.dims.length, this.dims.beam);
  };

  /* ---------------------------------------------------------------------
     World — owns the waterway, static furniture, traffic and own ship.
     ------------------------------------------------------------------ */
  function World(scenarioId) {
    this.rng = new NS.math.Rng(CFG.seed);
    this.waterway = new Waterway(CFG.waterway);
    this.time = 0;
    this.entities = [];
    this.events = [];
    this.scenario = scenarioId || 'normal';
    this.sensorFaults = {};
    this.build();
    this.ownShip = new OwnShip(this, CFG.ownShip);
  }

  World.prototype.onLoop = function () { /* hook for scenario restarts */ };

  World.prototype.build = function () {
    const rng = this.rng, ww = this.waterway;
    const add = (o) => { const e = new GtEntity(o); this.entities.push(e); return e; };

    /* --- bridge at station 1120: deck, two pillars, one navigable opening */
    const bs = 1120;
    const bAt = ww.at(bs);
    this.bridge = {
      id: 'BRIDGE_003', station: bs,
      centre: bAt.p, heading: bAt.heading,
      clearance: 9.4,              // m above water at the opening
      openingWidth: 34.0,
      openingOffset: 6,            // opening centre, offset to starboard of centreline
      spanHalf: bAt.halfWidth + 22
    };
    const halfOpen = this.bridge.openingWidth / 2;
    [-1, 1].forEach((side, i) => {
      const off = this.bridge.openingOffset + side * halfOpen;
      add({
        id: 'GT_PILLAR_' + (i + 1), cls: 'bridge_pillar', static: true,
        position: ww.point(bs, off),
        heading: bAt.heading,
        dims: { length: 9, beam: 7, height: 12 },
        rcs: 2.4, visualSize: 1.5
      });
    });

    /* --- lock entrance far north (structure only, not modelled as passable) */
    const ls = 1620, lAt = ww.at(ls);
    this.lock = { id: 'LOCK_001', station: ls, centre: lAt.p, heading: lAt.heading, width: 26 };

    /* --- buoys marking the channel edges, alternating sides ---------------- */
    for (let s = 120; s < ww.length - 80; s += 165) {
      const a = ww.at(s);
      [-1, 1].forEach((side, i) => {
        add({
          id: 'GT_BUOY_' + s + '_' + i, cls: 'buoy', static: true,
          position: ww.point(s, side * (a.halfWidth - 9)),
          heading: 0, dims: { length: 2.2, beam: 2.2, height: 2.6 },
          rcs: 0.35, visualSize: 0.3
        });
      });
    }

    /* --- quay + docked vessels on the east bank --------------------------- */
    this.quay = { from: 640, to: 900, offset: 1 };
    for (let k = 0; k < 3; k++) {
      const s = 690 + k * 78;
      const a = ww.at(s);
      add({
        id: 'GT_DOCKED_' + k, cls: 'vessel', static: true,
        position: ww.point(s, a.halfWidth - 14),
        heading: a.heading, dims: { length: 62 + k * 9, beam: 9.5, height: 6 },
        rcs: 1.6, visualSize: 1.2, transmitsAis: true, label: 'moored cargo vessel'
      });
    }

    /* --- moving traffic ---------------------------------------------------- */
    const traffic = [
      { id: 'GT_V1', s: 520, offset: -26, speed: 3.2, dir: 1, len: 86, beam: 11.4, ais: true, label: 'cargo vessel' },
      { id: 'GT_V2', s: 980, offset: 24, speed: 3.6, dir: -1, len: 105, beam: 11.4, ais: true, label: 'cargo vessel' },
      { id: 'GT_V3', s: 1480, offset: 20, speed: 2.9, dir: -1, len: 74, beam: 9.6, ais: false, label: 'cargo vessel' }
    ];
    traffic.forEach((t) => {
      const e = add({
        id: t.id, cls: 'vessel',
        position: ww.point(t.s, t.offset), heading: 0,
        dims: { length: t.len, beam: t.beam, height: 7.2 },
        rcs: 1.8, visualSize: 1.3, transmitsAis: t.ais, label: t.label,
        agent: new TrafficAgent({ s: t.s, offset: t.offset, speed: t.speed, dir: t.dir })
      });
      e.agent.apply(e, this);
    });

    /* --- small recreational craft ------------------------------------------ */
    for (let k = 0; k < 2; k++) {
      const s = 320 + k * 610, off = (k % 2 ? 1 : -1) * 34;
      const e = add({
        id: 'GT_SC_' + k, cls: 'small_craft',
        position: ww.point(s, off), heading: 0,
        dims: { length: 9, beam: 3.1, height: 2.4 },
        rcs: 0.28, visualSize: 0.35, label: 'recreational craft',
        agent: new TrafficAgent({ s, offset: off, speed: 5.4, dir: k % 2 ? -1 : 1, drift: 0 })
      });
      e.agent.apply(e, this);
    }

    /* --- floating obstacle: drifting, low RCS, initially ambiguous --------- */
    const os = 400;
    const ob = add({
      id: 'GT_OBST_1', cls: 'floating_obstacle',
      position: ww.point(os, 8), heading: 0,
      dims: { length: 4.4, beam: 2.8, height: 0.9 },
      rcs: 0.12, visualSize: 0.16, label: 'floating debris',
      agent: new TrafficAgent({ s: os, offset: 8, speed: 0.35, dir: 1, drift: 0.05 })
    });
    ob.agent.apply(ob, this);

    this.applyScenario();
  };

  /* --- scenarios (§33) --------------------------------------------------- */
  World.prototype.applyScenario = function () {
    const find = (id) => this.entities.find((e) => e.id === id);
    const ww = this.waterway;

    if (this.scenario === 'collision') {
      /* V2 runs down the wrong side and drifts across our lane */
      const v = find('GT_V2');
      v.agent.s = 620; v.agent.offset = -30; v.agent.speed = 4.3;
      v.agent.targetOffset = -30;
      v.agent.script = (a, dt, world) => {
        const own = world.ownShip ? world.ownShip.stationEstimate : 0;
        const gap = a.s - own;
        if (gap < 520 && gap > 60) a.targetOffset = CFG.ownShip.laneOffset + 4;  // crosses into us
      };
    }
    if (this.scenario === 'obstacle') {
      const ob = find('GT_OBST_1');
      ob.agent.s = 340; ob.agent.offset = CFG.ownShip.laneOffset;
      ob.agent.speed = 0.2;
    }
    if (this.scenario === 'occlusion') {
      /* V1 tucks in directly behind V2 so it is hidden from the bow sensors */
      const v1 = find('GT_V1'), v2 = find('GT_V2');
      v1.agent.s = 700; v1.agent.offset = 6; v1.agent.speed = 3.0; v1.agent.dir = -1;
      v2.agent.s = 760; v2.agent.offset = 4; v2.agent.speed = 3.0; v2.agent.dir = -1;
    }
    if (this.scenario === 'bridge') {
      /* clear the traffic out of the way so the approach reads cleanly */
      this.entities.forEach((e) => {
        if (e.agent && (e.cls === 'vessel' || e.cls === 'small_craft')) e.agent.s = 1560;
      });
      this.startStation = 470;      // ~650 m south of the bridge
      void ww;
    }
  };

  World.prototype.step = function (dt) {
    this.time += dt;
    for (const e of this.entities) {
      if (e.agent) { e.agent.step(dt, this, this.time); e.agent.apply(e, this); }
    }
    this.ownShip.step(dt, this);

    /* scenario 5: scripted sensor degradation */
    if (this.scenario === 'sensorfail') {
      const phase = this.time % 60;
      this.sensorFaults = {};
      if (phase > 14 && phase < 40) this.sensorFaults['CAM-BOW-WIDE'] = 'OFFLINE';
      if (phase > 22 && phase < 34) this.sensorFaults['CAM-BOW-TELE'] = 'DEGRADED';
    } else {
      /* light, deterministic flicker so the operator sees graceful degradation */
      this.sensorFaults = {};
      if (Math.sin(this.time / 17) > 0.94) this.sensorFaults['CAM-BOW-TELE'] = 'DEGRADED';
    }
  };

  /* line-of-sight: is the segment a→b blocked by another hull? */
  World.prototype.occluded = function (a, b, ignoreId) {
    for (const e of this.entities) {
      if (e.id === ignoreId) continue;
      if (e.cls !== 'vessel' && e.cls !== 'bridge_pillar') continue;
      if (e.dims.length < 20 && e.cls === 'vessel') continue;
      const poly = e.footprint();
      if (segmentIntersectsPoly(a, b, poly)) return true;
    }
    return false;
  };

  function segmentIntersectsPoly(a, b, poly) {
    for (let i = 0; i < poly.length; i++) {
      const c = poly[i], d = poly[(i + 1) % poly.length];
      if (segSeg(a, b, c, d)) return true;
    }
    return false;
  }
  function segSeg(p1, p2, p3, p4) {
    const d = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);
    if (Math.abs(d) < 1e-9) return false;
    const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / d;
    const ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / d;
    return ua > 0 && ua < 1 && ub > 0 && ub < 1;
  }

  NS.world = { World, Waterway, GtEntity, TrafficAgent, OwnShip };
})(window.CORNU);
