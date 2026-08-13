/* =============================================================================
   50-renderer.js — VISUALISATION.

   Draws from the WorldModel. The only ground-truth access is the explicit
   "Ground truth" overlay layer, which exists so the operator can compare
   reality with CORNU's estimate (§22, §47).

   A minimal 3D pipeline on Canvas 2D: view basis → perspective divide →
   near-plane segment clipping → painter-ordered layers. The style is
   wireframe-and-annotation, so this is cheaper and sharper than a mesh
   renderer; swapping in Three.js later replaces this file alone.
   ========================================================================== */
(function (NS) {
  'use strict';
  const { V, clamp, lerp, fwd, port, wrapPi, rectCorners, deg } = NS.math;
  const CFG = NS.CFG, C = CFG.color;

  /* =====================================================================
     Camera
     ================================================================== */
  function Camera() {
    this.mode = 'chase';
    this.eye = { x: 0, y: -160, z: 70 };
    this.target = { x: 0, y: 0, z: 0 };
    this.fov = 52;
    this.orbit = { yaw: 0, pitch: 0, dist: 1 };     // user adjustment on top of the mode
    this.smoothEye = null;
    this.smoothTarget = null;
  }

  Camera.prototype.follow = function (own, dt) {
    if (!own) return;
    const h = own.heading, F = fwd(h), P = port(h);
    const o = this.orbit;
    let eye, tgt;

    switch (this.mode) {
      case 'bird':
        tgt = { x: own.position.x, y: own.position.y, z: 0 };
        eye = { x: own.position.x - F.x * 40, y: own.position.y - F.y * 40, z: 520 * o.dist };
        break;
      case 'bow':
        tgt = { x: own.position.x + F.x * 400, y: own.position.y + F.y * 400, z: 6 };
        eye = { x: own.position.x + F.x * 50, y: own.position.y + F.y * 50, z: 21 };
        break;
      case 'free':
        tgt = { x: own.position.x, y: own.position.y, z: 0 };
        eye = {
          x: own.position.x + Math.sin(o.yaw) * 300 * o.dist,
          y: own.position.y + Math.cos(o.yaw) * 300 * o.dist,
          z: 60 + 260 * clamp(0.5 + o.pitch, 0.05, 1.6) * o.dist
        };
        break;
      default: {  /* chase — slightly above and behind the vessel */
        const back = 196 * o.dist, up = 118 * o.dist * clamp(0.45 + o.pitch + 0.4, 0.25, 1.9);
        const yawOff = o.yaw;
        const bx = F.x * Math.cos(yawOff) + P.x * Math.sin(yawOff);
        const by = F.y * Math.cos(yawOff) + P.y * Math.sin(yawOff);
        tgt = { x: own.position.x + F.x * 128, y: own.position.y + F.y * 128, z: 0 };
        eye = { x: own.position.x - bx * back, y: own.position.y - by * back, z: up };
      }
    }
    const k = clamp(dt * 3.2, 0, 1);
    if (!this.smoothEye) { this.smoothEye = eye; this.smoothTarget = tgt; }
    this.smoothEye = {
      x: lerp(this.smoothEye.x, eye.x, k), y: lerp(this.smoothEye.y, eye.y, k),
      z: lerp(this.smoothEye.z, eye.z, k)
    };
    this.smoothTarget = {
      x: lerp(this.smoothTarget.x, tgt.x, k), y: lerp(this.smoothTarget.y, tgt.y, k),
      z: lerp(this.smoothTarget.z, tgt.z, k)
    };
    this.eye = this.smoothEye; this.target = this.smoothTarget;
  };

  /* =====================================================================
     Projection
     ================================================================== */
  function Projector(camera, w, h) {
    this.w = w; this.h = h;
    const e = camera.eye, t = camera.target;
    let z = V.norm({ x: e.x - t.x, y: e.y - t.y, z: e.z - t.z });      // backward
    const upW = { x: 0, y: 0, z: 1 };
    let x = V.norm({
      x: upW.y * z.z - upW.z * z.y, y: upW.z * z.x - upW.x * z.z, z: upW.x * z.y - upW.y * z.x
    });
    if (!isFinite(x.x)) x = { x: 1, y: 0, z: 0 };
    const y = { x: z.y * x.z - z.z * x.y, y: z.z * x.x - z.x * x.z, z: z.x * x.y - z.y * x.x };
    this.e = e; this.bx = x; this.by = y; this.bz = z;
    this.f = (h / 2) / Math.tan((camera.fov * Math.PI / 180) / 2);
    this.near = 1.2;
  }
  /* world → camera space */
  Projector.prototype.cam = function (p) {
    const dx = p.x - this.e.x, dy = p.y - this.e.y, dz = (p.z || 0) - this.e.z;
    return {
      x: dx * this.bx.x + dy * this.bx.y + dz * this.bx.z,
      y: dx * this.by.x + dy * this.by.y + dz * this.by.z,
      z: dx * this.bz.x + dy * this.bz.y + dz * this.bz.z    // negative = in front
    };
  };
  Projector.prototype.toScreen = function (c) {
    const d = -c.z;
    return { x: this.w / 2 + this.f * c.x / d, y: this.h / 2 - this.f * c.y / d, d };
  };
  Projector.prototype.project = function (p) {
    const c = this.cam(p);
    if (-c.z < this.near) return null;
    return this.toScreen(c);
  };
  /* segment with near-plane clipping */
  Projector.prototype.segment = function (a, b) {
    let ca = this.cam(a), cb = this.cam(b);
    const da = -ca.z - this.near, db = -cb.z - this.near;
    if (da < 0 && db < 0) return null;
    if (da < 0 || db < 0) {
      const t = da / (da - db);
      const mid = {
        x: ca.x + (cb.x - ca.x) * t, y: ca.y + (cb.y - ca.y) * t, z: ca.z + (cb.z - ca.z) * t
      };
      if (da < 0) ca = mid; else cb = mid;
    }
    return [this.toScreen(ca), this.toScreen(cb)];
  };

  /* =====================================================================
     Renderer
     ================================================================== */
  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = new Camera();
    this.dpr = 1;
    /* Two display densities. Clean is the default: what an operator should
       see. Engineering restores every diagnostic layer. */
    this.dense = false;
    this.layers = {
      semantic: true, ids: true, predictions: true, corridor: true, swept: true,
      occupancy: false, rawObs: false, frustums: false, uncertainty: false,
      history: false, groundTruth: false, ranges: false, decor: true
    };
    this.presets = {
      clean: { semantic: 1, ids: 1, predictions: 1, corridor: 1, swept: 1,
               occupancy: 0, rawObs: 0, frustums: 0, uncertainty: 0,
               history: 0, groundTruth: 0, ranges: 0 },
      dense: { semantic: 1, ids: 1, predictions: 1, corridor: 1, swept: 1,
               occupancy: 0, rawObs: 1, frustums: 0, uncertainty: 1,
               history: 1, groundTruth: 0, ranges: 1 }
    };
    this.selectedId = null;
    this.pickables = [];
    this.resize();
  }

  Renderer.prototype.resize = function () {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(2, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(2, Math.round(r.height * this.dpr));
    this.W = r.width; this.H = r.height;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  };

  /* --- primitives -------------------------------------------------------- */
  Renderer.prototype.line = function (P, a, b, style, width, dash) {
    const s = P.segment(a, b);
    if (!s) return;
    const g = this.ctx;
    g.strokeStyle = style; g.lineWidth = width || 1;
    if (dash) g.setLineDash(dash);
    g.beginPath(); g.moveTo(s[0].x, s[0].y); g.lineTo(s[1].x, s[1].y); g.stroke();
    if (dash) g.setLineDash([]);
  };
  Renderer.prototype.polyline = function (P, pts, style, width, close, dash) {
    for (let i = 0; i < pts.length - 1; i++) this.line(P, pts[i], pts[i + 1], style, width, dash);
    if (close && pts.length > 2) this.line(P, pts[pts.length - 1], pts[0], style, width, dash);
  };
  Renderer.prototype.fillPoly = function (P, pts, fill) {
    const g = this.ctx, scr = [];
    for (const p of pts) { const s = P.project(p); if (!s) return; scr.push(s); }
    g.fillStyle = fill; g.beginPath();
    g.moveTo(scr[0].x, scr[0].y);
    for (let i = 1; i < scr.length; i++) g.lineTo(scr[i].x, scr[i].y);
    g.closePath(); g.fill();
  };
  Renderer.prototype.mono = function (size, weight) {
    this.ctx.font = (weight || 400) + ' ' + size + 'px "IBM Plex Mono", ui-monospace, monospace';
  };
  Renderer.prototype.text = function (str, x, y, color, size, weight, align) {
    const g = this.ctx;
    this.mono(size || 10, weight);
    g.fillStyle = color; g.textAlign = align || 'left'; g.textBaseline = 'alphabetic';
    g.fillText(str, x, y);
    g.textAlign = 'left';
  };

  /* 3D oriented bounding box from a footprint and a height */
  Renderer.prototype.box = function (P, centre, heading, length, beam, height, style, width) {
    const c = rectCorners(centre, heading, length, beam);
    const lo = c.map((q) => ({ x: q.x, y: q.y, z: 0 }));
    const hi = c.map((q) => ({ x: q.x, y: q.y, z: height }));
    this.polyline(P, lo, style, width, true);
    this.polyline(P, hi, style, width, true);
    for (let i = 0; i < 4; i++) this.line(P, lo[i], hi[i], style, width);
    /* bow chevron so heading is unambiguous */
    const F = fwd(heading);
    const nose = { x: centre.x + F.x * length * 0.62, y: centre.y + F.y * length * 0.62, z: height * 0.5 };
    this.line(P, hi[0], nose, style, width);
    this.line(P, hi[1], nose, style, width);
  };

  /* -----------------------------------------------------------------------
     Solid shapes. A wireframe scene reads as debug output; filled geometry
     with a lit top face and darker sides reads as a product. Faces are
     painter-sorted within each object, and objects are drawn back-to-front.
     -------------------------------------------------------------------- */
  Renderer.prototype.hullShape = function (centre, heading, length, beam) {
    const F = fwd(heading), Pt = port(heading);
    const pts = [[0.50, 0], [0.34, 0.5], [-0.5, 0.5], [-0.5, -0.5], [0.34, -0.5]];
    return pts.map((q) => ({
      x: centre.x + F.x * (q[0] * length) + Pt.x * (q[1] * beam),
      y: centre.y + F.y * (q[0] * length) + Pt.y * (q[1] * beam)
    }));
  };

  Renderer.prototype.solid = function (P, centre, heading, length, beam, height, tone, alpha) {
    const base = this.hullShape(centre, heading, length, beam);
    const lo = base.map((q) => ({ x: q.x, y: q.y, z: 0 }));
    const hi = base.map((q) => ({ x: q.x, y: q.y, z: height }));
    const g = this.ctx;
    const faces = [];
    for (let i = 0; i < base.length; i++) {
      const j = (i + 1) % base.length;
      const quad = [lo[i], lo[j], hi[j], hi[i]];
      const c = P.cam({ x: (lo[i].x + lo[j].x) / 2, y: (lo[i].y + lo[j].y) / 2, z: height / 2 });
      faces.push({ pts: quad, depth: -c.z, shade: 0.55 });
    }
    const ct = P.cam({ x: centre.x, y: centre.y, z: height });
    faces.push({ pts: hi, depth: -ct.z - 0.01, shade: 1 });
    faces.sort((a, b) => b.depth - a.depth);

    for (const f of faces) {
      const scr = [];
      let ok = true;
      for (const p of f.pts) { const s = P.project(p); if (!s) { ok = false; break; } scr.push(s); }
      if (!ok) continue;
      g.beginPath();
      g.moveTo(scr[0].x, scr[0].y);
      for (let i = 1; i < scr.length; i++) g.lineTo(scr[i].x, scr[i].y);
      g.closePath();
      g.fillStyle = shade(tone, f.shade, alpha);
      g.fill();
      g.strokeStyle = shade(tone, f.shade * 1.5 + 0.25, alpha * 0.55);
      g.lineWidth = 1;
      g.stroke();
    }
  };

  /* smooth ribbon between two edge polylines, with a fade along its length */
  Renderer.prototype.ribbon = function (P, L, R, rgb, a0, a1) {
    const g = this.ctx;
    for (let i = 0; i < L.length - 1; i++) {
      const t = i / Math.max(1, L.length - 2);
      const a = a0 + (a1 - a0) * t;
      const scr = [];
      let ok = true;
      for (const p of [L[i], L[i + 1], R[i + 1], R[i]]) {
        const s = P.project(p); if (!s) { ok = false; break; } scr.push(s);
      }
      if (!ok) continue;
      g.beginPath();
      g.moveTo(scr[0].x, scr[0].y);
      for (let k = 1; k < 4; k++) g.lineTo(scr[k].x, scr[k].y);
      g.closePath();
      g.fillStyle = 'rgba(' + rgb + ',' + a.toFixed(4) + ')';
      g.fill();
    }
  };

  Renderer.prototype.ellipse = function (P, centre, a, b, angle, style, width, dash) {
    const pts = [];
    for (let i = 0; i <= 28; i++) {
      const t = (i / 28) * Math.PI * 2;
      const ex = a * Math.cos(t), ey = b * Math.sin(t);
      pts.push({
        x: centre.x + ex * Math.cos(angle) - ey * Math.sin(angle),
        y: centre.y + ex * Math.sin(angle) + ey * Math.cos(angle),
        z: 0.2
      });
    }
    this.polyline(P, pts, style, width || 1, false, dash);
  };

  /* =====================================================================
     Frame
     ================================================================== */
  Renderer.prototype.render = function (wm, provider, world, dt, viewMode) {
    const g = this.ctx;
    this.camera.follow(wm.getOwnVessel(), dt);
    const P = new Projector(this.camera, this.W, this.H);
    this.pickables = [];

    g.clearRect(0, 0, this.W, this.H);
    const bg = g.createLinearGradient(0, 0, 0, this.H);
    bg.addColorStop(0, '#040605'); bg.addColorStop(0.52, '#080C0A'); bg.addColorStop(1, '#050807');
    g.fillStyle = bg; g.fillRect(0, 0, this.W, this.H);

    const own = wm.getOwnVessel();
    if (!own) return;
    const modelOnly = viewMode === 'model';

    this.drawHorizonGrid(P, own, modelOnly);

    if (this.layers.occupancy) this.drawOccupancy(P, wm);
    if (this.layers.corridor) this.drawCorridor(P, wm);
    this.drawStaticMap(P, wm);
    if (this.layers.ranges) this.drawRangeRings(P, own);
    if (this.layers.frustums) this.drawFrustums(P, provider, world);
    if (this.layers.rawObs) this.drawRawObservations(P, provider);
    if (this.layers.groundTruth && world) this.drawGroundTruth(P, world);

    this.drawBridge(P, wm);
    if (this.layers.swept) this.drawSweptVolume(P, wm);
    this.drawOwnShip(P, own);
    this.drawEntities(P, wm);
    this.drawConflicts(P, wm);
    this.drawCompass(own, wm);
  };

  /* --- water & horizon --------------------------------------------------- */
  Renderer.prototype.drawWater = function (P, own) {
    const g = this.ctx;
    const grd = g.createLinearGradient(0, 0, 0, this.H);
    grd.addColorStop(0, '#070B0C'); grd.addColorStop(1, '#040708');
    g.fillStyle = grd; g.fillRect(0, 0, this.W, this.H);
    void P; void own;
  };

  Renderer.prototype.drawHorizonGrid = function (P, own, modelOnly) {
    /* Deliberately almost nothing. A lattice across the whole world reads as
       debug output; a few faint range arcs ahead give scale without noise. */
    if (!this.layers.ranges) return;
    void modelOnly;
    for (const r of [100, 250, 500, 1000]) {
      const pts = [];
      for (let i = -34; i <= 34; i++) {
        const a = own.heading + (i / 34) * 1.15;
        pts.push({ x: own.position.x + Math.sin(a) * r, y: own.position.y + Math.cos(a) * r, z: 0 });
      }
      this.polyline(P, pts, 'rgba(245,246,242,0.055)', 1);
    }
  };

  /* --- accumulated bank memory ------------------------------------------- */
  Renderer.prototype.drawStaticMap = function (P, wm) {
    const g = this.ctx;
    const own = wm.getOwnVessel().position;
    const cells = wm.staticMap.near(own, 700);
    for (const c of cells) {
      const s = P.project({ x: c.x, y: c.y, z: 0 });
      if (!s || s.x < -40 || s.x > this.W + 40 || s.y < 0 || s.y > this.H) continue;
      const range = Math.hypot(c.x - own.x, c.y - own.y);
      const fade = clamp(1 - (range - 220) / 420, 0.10, 1);
      const conf = wm.staticMap.confidenceOf(c);
      const size = clamp(240 / s.d, 0.6, 2.4);
      g.fillStyle = 'rgba(150,166,156,' + (0.10 + conf * 0.26).toFixed(3) * fade + ')';
      g.fillStyle = 'rgba(150,166,156,' + ((0.10 + conf * 0.26) * fade).toFixed(3) + ')';
      g.fillRect(s.x - size / 2, s.y - size / 2, size, size);
    }
  };

  /* --- occupancy --------------------------------------------------------- */
  Renderer.prototype.drawOccupancy = function (P, wm) {
    const occ = wm.getOccupancy(), g = this.ctx, cell = CFG.occupancy.cell;
    const draw = (list, colFn) => {
      for (const c of list) {
        const s = P.project({ x: c.x, y: c.y, z: 0.1 });
        if (!s) continue;
        const w = clamp((this.H * cell) / (s.d * 1.6), 1, 26);
        g.fillStyle = colFn(c.p);
        g.fillRect(s.x - w / 2, s.y - w / 2, w, w);
      }
    };
    draw(occ.free, () => 'rgba(201,242,110,0.045)');
    draw(occ.occupied, (p) => 'rgba(224,138,75,' + (0.10 + p * 0.22).toFixed(3) + ')');
  };

  /* --- navigable corridor ------------------------------------------------ */
  Renderer.prototype.drawCorridor = function (P, wm) {
    const cor = wm.getNavigableSpace();
    if (!cor || !cor.sections.length) return;
    const L = [], R = [];
    for (const s of cor.sections) {
      const Pt = port(s.heading);
      L.push({ x: s.centre.x + Pt.x * s.portLimit, y: s.centre.y + Pt.y * s.portLimit, z: 0.08 });
      R.push({ x: s.centre.x - Pt.x * s.stbdLimit, y: s.centre.y - Pt.y * s.stbdLimit, z: 0.08 });
    }
    /* the navigable water reads as a surface, not as two dashed lines */
    this.ribbon(P, L, R, '150,178,150', 0.075, 0.008);
    this.polyline(P, L, 'rgba(201,242,110,0.20)', 1);
    this.polyline(P, R, 'rgba(201,242,110,0.20)', 1);
  };

  /* --- range rings ------------------------------------------------------- */
  Renderer.prototype.drawRangeRings = function (P, own) {
    const rings = [50, 100, 250, 500, 1000];
    for (const r of rings) {
      const pts = [];
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        pts.push({ x: own.position.x + Math.cos(a) * r, y: own.position.y + Math.sin(a) * r, z: 0.1 });
      }
      this.polyline(P, pts, 'rgba(245,246,242,0.08)', 1, true);
      const F = fwd(own.heading);
      const lab = P.project({ x: own.position.x + F.x * r, y: own.position.y + F.y * r, z: 1 });
      if (lab) this.text(r + ' m', lab.x + 4, lab.y - 3, 'rgba(245,246,242,0.28)', 9);
    }
  };

  /* --- sensor frustums --------------------------------------------------- */
  Renderer.prototype.drawFrustums = function (P, provider, world) {
    if (!provider || !world) return;
    const own = world.ownShip;
    for (const s of provider.sensorList()) {
      const pose = provider.poseOf(s, own);
      const faults = world.sensorFaults || {};
      if (faults[s.id] === 'OFFLINE') continue;
      const col = s.type === 'radar' ? 'rgba(120,160,200,0.16)'
        : s.type === 'lidar' ? 'rgba(201,242,110,0.16)'
        : s.type === 'ais' ? 'rgba(200,150,220,0.10)' : 'rgba(245,246,242,0.13)';
      const half = Math.min(s.fov, 359) / 2, r = Math.min(s.range, 520);
      const pts = [{ x: pose.position.x, y: pose.position.y, z: pose.position.z }];
      for (let i = 0; i <= 16; i++) {
        const rel = (-half + (2 * half * i) / 16) * Math.PI / 180;
        const h = pose.heading - rel;
        const F = fwd(h);
        pts.push({ x: pose.position.x + F.x * r, y: pose.position.y + F.y * r, z: 0.4 });
      }
      this.polyline(P, pts, col, 1, true);
    }
  };

  /* --- raw observations (pre-fusion) ------------------------------------- */
  Renderer.prototype.drawRawObservations = function (P, provider) {
    const g = this.ctx;
    const buf = provider.recentObservations || [];
    for (const o of buf) {
      const s = P.project(o.estimatedPosition);
      if (!s) continue;
      const age = clamp(1 - o._age / 1.2, 0, 1);
      g.lineWidth = 1;
      if (o.measurementType === 'radar') {
        g.strokeStyle = 'rgba(120,160,200,' + (0.75 * age).toFixed(2) + ')';
        g.beginPath(); g.arc(s.x, s.y, 3, 0, 6.283); g.stroke();
      } else if (o.measurementType === 'vision') {
        g.strokeStyle = 'rgba(245,246,242,' + (0.75 * age).toFixed(2) + ')';
        g.beginPath();
        g.moveTo(s.x - 3, s.y - 3); g.lineTo(s.x + 3, s.y + 3);
        g.moveTo(s.x + 3, s.y - 3); g.lineTo(s.x - 3, s.y + 3); g.stroke();
      } else if (o.measurementType === 'lidar') {
        g.strokeStyle = 'rgba(201,242,110,' + (0.75 * age).toFixed(2) + ')';
        g.beginPath();
        g.moveTo(s.x - 3.5, s.y); g.lineTo(s.x + 3.5, s.y);
        g.moveTo(s.x, s.y - 3.5); g.lineTo(s.x, s.y + 3.5); g.stroke();
      } else if (o.measurementType === 'ais') {
        g.strokeStyle = 'rgba(200,150,220,' + (0.8 * age).toFixed(2) + ')';
        g.beginPath();
        g.moveTo(s.x, s.y - 4); g.lineTo(s.x + 4, s.y);
        g.lineTo(s.x, s.y + 4); g.lineTo(s.x - 4, s.y); g.closePath(); g.stroke();
      }
    }
  };

  /* --- ground truth overlay ---------------------------------------------- */
  Renderer.prototype.drawGroundTruth = function (P, world) {
    for (const e of world.entities) {
      this.box(P, e.position, e.heading, e.dims.length, e.dims.beam, e.dims.height,
        'rgba(120,140,128,0.45)', 1);
    }
    this.box(P, world.ownShip.position, world.ownShip.heading,
      world.ownShip.dims.length, world.ownShip.dims.beam, world.ownShip.dims.height,
      'rgba(120,140,128,0.45)', 1);
  };

  /* --- bridge ------------------------------------------------------------ */
  Renderer.prototype.drawBridge = function (P, wm) {
    const b = wm.getBridgeState();
    if (!b) return;
    const Pt = port(b.heading), F = fwd(b.heading);
    const halfOpen = b.openingWidth / 2, off = b.openingOffset;
    const span = 140;
    const deckZ = b.clearance;
    const at = (o, z) => ({ x: b.position.x - Pt.x * o, y: b.position.y - Pt.y * o, z });
    const col = 'rgba(245,246,242,' + (0.16 + b.confidence * 0.34).toFixed(3) + ')';
    /* deck */
    this.line(P, at(-span, deckZ), at(span, deckZ), col, 1.4);
    this.line(P, at(-span, deckZ + 2.4), at(span, deckZ + 2.4), col, 1);
    /* opening highlight */
    const sig = 'rgba(201,242,110,' + (0.35 + b.confidence * 0.5).toFixed(3) + ')';
    this.line(P, at(off - halfOpen, 0), at(off - halfOpen, deckZ), sig, 1.6);
    this.line(P, at(off + halfOpen, 0), at(off + halfOpen, deckZ), sig, 1.6);
    this.line(P, at(off - halfOpen, deckZ), at(off + halfOpen, deckZ), sig, 1.6);
    /* clearance dimension at the opening centre */
    const cA = at(off, 0), cB = at(off, deckZ);
    this.line(P, cA, cB, sig, 1, [3, 4]);
    const lab = P.project({ x: cB.x + F.x * 2, y: cB.y + F.y * 2, z: deckZ * 0.55 });
    if (lab) {
      this.text(b.clearance.toFixed(2) + ' m', lab.x + 6, lab.y, C.signal, 10, 500);
      this.text(b.id + ' · ' + (b.range ? b.range.toFixed(0) + ' m' : ''),
        lab.x + 6, lab.y - 13, 'rgba(245,246,242,0.6)', 9);
      this.text(b.passable ? 'PASSABLE' : 'NOT PASSABLE', lab.x + 6, lab.y + 13,
        b.passable ? C.signal : C.risk.critical, 9, 500);
    }
  };

  /* --- own ship + swept volume -------------------------------------------- */
  Renderer.prototype.drawOwnShip = function (P, own) {
    this.solid(P, own.position, own.heading, own.dimensions.length,
      own.dimensions.beam, own.dimensions.height, '#E6E9E2', 0.82);
  };

  Renderer.prototype.drawSweptVolume = function (P, wm) {
    const sv = wm.getPredictions().own;
    if (!sv) return;
    const L = [], R = [];
    for (const f of sv.footprints) {
      const Pt = port(f.heading);
      L.push({ x: f.centre.x + Pt.x * f.beam / 2, y: f.centre.y + Pt.y * f.beam / 2, z: 0.3 });
      R.push({ x: f.centre.x - Pt.x * f.beam / 2, y: f.centre.y - Pt.y * f.beam / 2, z: 0.3 });
    }
    /* one continuous path the vessel intends to occupy, fading with distance */
    this.ribbon(P, L, R, '201,242,110', 0.20, 0.012);
    this.polyline(P, L, 'rgba(201,242,110,0.30)', 1.2);
    this.polyline(P, R, 'rgba(201,242,110,0.30)', 1.2);

    /* time markers only in engineering density */
    if (!this.dense) return;
    for (const f of sv.footprints) {
      if (CFG.prediction.horizons.indexOf(f.t) < 0) continue;
      const s = P.project({ x: f.centre.x, y: f.centre.y, z: 0.6 });
      if (s) this.text('+' + f.t + 's', s.x + 5, s.y - 3, 'rgba(245,246,242,0.30)', 9);
    }
  };

  /* --- tracked entities ---------------------------------------------------- */
  Renderer.prototype.drawEntities = function (P, wm) {
    const own = wm.getOwnVessel();
    const list = wm.getEntities().slice().sort((a, b) =>
      V.dist2d(b.position, own.position) - V.dist2d(a.position, own.position));
    const labels = [];

    for (const e of list) {
      const range = V.dist2d(e.position, own.position);
      const s = P.project({ x: e.position.x, y: e.position.y, z: 0 });
      if (!s) continue;
      const sel = this.selectedId === e.id;
      const risky = e.riskLevel === 'high' || e.riskLevel === 'critical' ||
                    e.riskLevel === 'medium';

      /* Colour carries meaning only when there is meaning to carry. Ordinary
         traffic is neutral; risk and coasting are the exceptions that earn a
         hue. Everything fades out with distance instead of piling up at the
         vanishing point. */
      const tone = risky ? (C.risk[e.riskLevel] || C.muted)
        : e.state === 'PREDICTED' ? C.risk.medium
        : '#9AA9A0';
      const fade = clamp(1 - (range - 260) / 460, 0.16, 1);
      const alpha = clamp(0.30 + e.confidence * 0.62, 0.2, 1) * fade;

      this.pickables.push({ id: e.id, x: s.x, y: s.y, entity: e });

      if (this.layers.history && e.history.length > 1) {
        this.polyline(P, e.history.map((q) => ({ x: q.x, y: q.y, z: 0.12 })),
          hexA(tone, 0.16 * fade), 1);
      }

      if (this.layers.semantic) {
        this.solid(P, e.position, e.heading, e.dimensions.length,
          e.dimensions.beam, e.dimensions.height, tone, alpha);
        if (sel) {
          this.polyline(P, this.hullShape(e.position, e.heading,
            e.dimensions.length + 14, e.dimensions.beam + 14)
            .map((q) => ({ x: q.x, y: q.y, z: 0.2 })), C.signal, 1.3, true);
        }
      }

      if (this.layers.uncertainty) {
        const el = e.ellipse;
        this.ellipse(P, e.position, Math.max(el.a, 1.5), Math.max(el.b, 1.5), el.angle,
          hexA(tone, 0.32 * fade), 1, [3, 4]);
      }

      if (this.layers.predictions && e.speed > 0.5) {
        const pts = e.prediction.points.map((q) => ({ x: q.x, y: q.y, z: 0.2 }));
        this.polyline(P, pts, hexA(tone, 0.40 * fade), 1, false, [5, 5]);
        if (this.dense) {
          for (const q of e.prediction.points) {
            if (q.t === 0) continue;
            this.ellipse(P, { x: q.x, y: q.y }, q.sigma, q.sigma * 0.62, e.heading,
              hexA(tone, 0.16 * fade), 1);
          }
        }
      }

      if (this.layers.ids) {
        const top = P.project({ x: e.position.x, y: e.position.y, z: e.dimensions.height + 5 });
        if (top && top.x > -50 && top.x < this.W + 50 && top.y > 40 && top.y < this.H) {
          const RANK = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
          labels.push({
            e, tone, sel, range, x: top.x, y: top.y, risky,
            priority: RANK[e.riskLevel] * 10000 + range - (sel ? 1e6 : 0)
          });
        }
      }
    }
    this.placeLabels(labels);
  };

  /* -----------------------------------------------------------------------
     Labels are the fastest way to ruin a scene. In clean density only the
     selected object and genuine hazards are named, on one line. Engineering
     density restores the full readout.
     -------------------------------------------------------------------- */
  Renderer.prototype.placeLabels = function (labels) {
    const g = this.ctx;
    const boxes = [], MAX = this.dense ? 10 : 4;
    labels.sort((a, b) => a.priority - b.priority);
    let drawn = 0;
    for (const L of labels) {
      if (drawn >= MAX) break;
      const e = L.e;
      const worth = L.sel || L.risky || e.state === 'PREDICTED' ||
                    (this.dense ? L.range < 320 : L.range < 190);
      if (!worth) continue;
      const w = this.dense ? 150 : 108, h = this.dense ? 36 : 14;
      const x = L.x + 7, y = L.y - 12 - h;
      let clash = false;
      for (const b of boxes) {
        if (x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y) { clash = true; break; }
      }
      if (clash) continue;
      boxes.push({ x, y, w, h });
      drawn++;

      g.strokeStyle = hexA(L.tone, 0.35); g.lineWidth = 1;
      g.beginPath(); g.moveTo(L.x, L.y); g.lineTo(L.x, L.y - 10); g.stroke();
      const head = L.sel ? C.signal : hexA(L.tone, 0.92);

      if (!this.dense) {
        this.text(e.id + '   ' + L.range.toFixed(0) + ' m', x, L.y - 12, head, 9.5, 500);
      } else {
        this.text(e.id + (e.state === 'PREDICTED' ? '  ·  COASTING' : ''), x, L.y - 12, head, 10, 500);
        this.text(labelFor(e), x, L.y, 'rgba(245,246,242,0.5)', 9);
        this.text(L.range.toFixed(0) + ' m   ' + (e.speed * 3.6).toFixed(1) + ' km/h   ' +
          (e.confidence * 100).toFixed(0) + '%', x, L.y + 11, 'rgba(245,246,242,0.36)', 9);
      }
    }
  };

  /* --- predicted conflict points ------------------------------------------- */
  Renderer.prototype.drawConflicts = function (P, wm) {
    const g = this.ctx;
    for (const r of wm.getRisks()) {
      if (!r.conflict) continue;
      const s = P.project({ x: r.conflict.x, y: r.conflict.y, z: 0.5 });
      if (!s) continue;
      const col = C.risk[r.level] || C.risk.high;
      const pulse = 0.55 + 0.45 * Math.abs(Math.sin(wm.time * 2.4));
      g.fillStyle = hexA(col, 0.13 * pulse);
      g.beginPath(); g.arc(s.x, s.y, 15, 0, 6.283); g.fill();
      g.strokeStyle = hexA(col, 0.75 * pulse); g.lineWidth = 1.3;
      g.beginPath(); g.arc(s.x, s.y, 10, 0, 6.283); g.stroke();
      this.text(r.conflict.t.toFixed(0) + ' s', s.x + 17, s.y + 3.5, col, 10, 500);
    }
  };

  /* --- compass ribbon ------------------------------------------------------ */
  Renderer.prototype.drawCompass = function (own, wm) {
    const g = this.ctx, w = this.W, y = 22;
    const hdg = (deg(own.heading) + 360) % 360;
    g.save();
    g.beginPath(); g.rect(w / 2 - 190, 0, 380, 40); g.clip();
    for (let d = -60; d <= 60; d += 10) {
      const b = (Math.round(hdg / 10) * 10 + d + 360) % 360;
      const x = w / 2 + ((Math.round(hdg / 10) * 10 + d) - hdg) * 3.1;
      const major = b % 30 === 0;
      g.strokeStyle = 'rgba(245,246,242,' + (major ? 0.3 : 0.14) + ')';
      g.beginPath(); g.moveTo(x, y - (major ? 8 : 4)); g.lineTo(x, y); g.stroke();
      if (major) this.text(String(b).padStart(3, '0'), x, y - 11, 'rgba(245,246,242,0.4)', 9, 400, 'center');
    }
    g.restore();
    g.strokeStyle = C.signal; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(w / 2, y - 13); g.lineTo(w / 2 - 4, y - 19); g.lineTo(w / 2 + 4, y - 19);
    g.closePath(); g.stroke();
    void wm;
  };

  /* --- picking ------------------------------------------------------------- */
  Renderer.prototype.pick = function (x, y) {
    let best = null, bestD = 42;
    for (const p of this.pickables) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? best.entity : null;
  };

  /* --- helpers -------------------------------------------------------------- */
  /* mix a hex tone toward white by `k`, at alpha `a` */
  function shade(hex, k, a) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const m = (v) => Math.round(clamp(v * k, 0, 255));
    return 'rgba(' + m(r) + ',' + m(g) + ',' + m(b) + ',' + clamp(a, 0, 1).toFixed(3) + ')';
  }
  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16), g2 = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g2 + ',' + b + ',' + clamp(a, 0, 1).toFixed(3) + ')';
  }
  function labelFor(e) {
    const names = {
      vessel: 'Cargo vessel', small_craft: 'Recreational craft',
      floating_obstacle: 'Floating obstacle', buoy: 'Navigation buoy',
      bridge_pillar: 'Bridge pillar', quay: 'Quay', unknown: 'Unclassified'
    };
    return (names[e.semanticClass] || e.semanticClass) +
      '  ' + (e.classConfidence * 100).toFixed(0) + '%';
  }

  NS.rendering = { Renderer, Camera, Projector, hexA, labelFor };
})(window.CORNU);
