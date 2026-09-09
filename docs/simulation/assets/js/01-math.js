/* =============================================================================
   01-math.js — deterministic RNG, small linear algebra, Kalman primitives.
   Everything here is pure: no simulation state, no DOM.
   ========================================================================== */
(function (NS) {
  'use strict';

  /* --- deterministic RNG (xorshift32) ----------------------------------- */
  function Rng(seed) {
    let s = (seed >>> 0) || 1;
    this.next = function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5;  s >>>= 0;
      return s / 4294967296;
    };
  }
  /* Box–Muller, cached second sample */
  Rng.prototype.normal = function (mu, sigma) {
    if (this._spare !== undefined) {
      const v = this._spare; this._spare = undefined;
      return mu + sigma * v;
    }
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const r = Math.sqrt(-2 * Math.log(u)), t = 2 * Math.PI * v;
    this._spare = r * Math.sin(t);
    return mu + sigma * r * Math.cos(t);
  };
  Rng.prototype.range = function (a, b) { return a + (b - a) * this.next(); };
  Rng.prototype.pick = function (arr) { return arr[Math.floor(this.next() * arr.length) % arr.length]; };

  /* --- scalars ----------------------------------------------------------- */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const deg = (r) => r * 180 / Math.PI;
  const rad = (d) => d * Math.PI / 180;

  /* --- 3-vectors as plain objects {x,y,z} -------------------------------- */
  const V = {
    make: (x, y, z) => ({ x: x || 0, y: y || 0, z: z || 0 }),
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
    mul: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
    dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
    len: (a) => Math.hypot(a.x, a.y, a.z),
    len2d: (a) => Math.hypot(a.x, a.y),
    norm: (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; },
    dist2d: (a, b) => Math.hypot(a.x - b.x, a.y - b.y),
    clone: (a) => ({ x: a.x, y: a.y, z: a.z })
  };

  /* Heading (compass, +Y = north, clockwise) → forward unit vector */
  const fwd = (h) => ({ x: Math.sin(h), y: Math.cos(h), z: 0 });
  /* Port unit vector (90° anticlockwise of forward, in the XY plane) */
  const port = (h) => ({ x: -Math.cos(h), y: Math.sin(h), z: 0 });
  const headingOf = (v) => Math.atan2(v.x, v.y);

  /* body (forward, port) → world offset */
  function bodyToWorld(origin, h, f, p, up) {
    const F = fwd(h), P = port(h);
    return {
      x: origin.x + F.x * f + P.x * p,
      y: origin.y + F.y * f + P.y * p,
      z: origin.z + (up || 0)
    };
  }
  /* world point → body-relative (forward, port) */
  function worldToBody(origin, h, pt) {
    const d = V.sub(pt, origin), F = fwd(h), P = port(h);
    return { f: d.x * F.x + d.y * F.y, p: d.x * P.x + d.y * P.y, up: d.z };
  }

  /* --- small dense matrices (arrays of arrays) --------------------------- */
  const M = {
    zeros: (n, m) => Array.from({ length: n }, () => new Array(m).fill(0)),
    eye: (n) => { const a = M.zeros(n, n); for (let i = 0; i < n; i++) a[i][i] = 1; return a; },
    mul: (A, B) => {
      const n = A.length, k = B.length, m = B[0].length, C = M.zeros(n, m);
      for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
        let s = 0; for (let t = 0; t < k; t++) s += A[i][t] * B[t][j];
        C[i][j] = s;
      }
      return C;
    },
    T: (A) => { const n = A.length, m = A[0].length, C = M.zeros(m, n);
      for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) C[j][i] = A[i][j]; return C; },
    add: (A, B) => A.map((r, i) => r.map((v, j) => v + B[i][j])),
    sub: (A, B) => A.map((r, i) => r.map((v, j) => v - B[i][j])),
    /* analytic 2x2 inverse — the only size we invert (innovation covariance) */
    inv2: (A) => {
      const d = A[0][0] * A[1][1] - A[0][1] * A[1][0] || 1e-9;
      return [[A[1][1] / d, -A[0][1] / d], [-A[1][0] / d, A[0][0] / d]];
    }
  };

  /* -------------------------------------------------------------------------
     Kalman filter, constant-velocity, state = [x, y, vx, vy]^T (world XY).

     This is deliberately a plain linear KF: it is the honest baseline the
     spec asks for, and PerceptionProvider/Tracker are separated so an EKF,
     UKF or factor graph can replace it without touching anything downstream.
     ---------------------------------------------------------------------- */
  function KF(x, y, vx, vy, cfg) {
    this.x = [[x], [y], [vx], [vy]];
    this.P = M.zeros(4, 4);
    this.P[0][0] = this.P[1][1] = cfg.initialPosVar;
    this.P[2][2] = this.P[3][3] = cfg.initialVelVar;
    this.q = cfg.processNoiseAccel;
  }

  KF.prototype.predict = function (dt) {
    const F = M.eye(4); F[0][2] = dt; F[1][3] = dt;
    this.x = M.mul(F, this.x);
    /* Q for a constant-velocity model driven by white acceleration noise */
    const s = this.q * this.q, t2 = dt * dt, t3 = t2 * dt / 2, t4 = t2 * t2 / 4;
    const Q = [
      [t4 * s, 0, t3 * s, 0],
      [0, t4 * s, 0, t3 * s],
      [t3 * s, 0, t2 * s, 0],
      [0, t3 * s, 0, t2 * s]
    ];
    this.P = M.add(M.mul(M.mul(F, this.P), M.T(F)), Q);
  };

  /* position update: z = [x, y], R = 2x2 measurement covariance */
  KF.prototype.updatePosition = function (zx, zy, R) {
    const H = [[1, 0, 0, 0], [0, 1, 0, 0]];
    const y = [[zx - this.x[0][0]], [zy - this.x[1][0]]];
    const S = M.add(M.mul(M.mul(H, this.P), M.T(H)), R);
    const K = M.mul(M.mul(this.P, M.T(H)), M.inv2(S));
    this.x = M.add(this.x, M.mul(K, y));
    this.P = M.mul(M.sub(M.eye(4), M.mul(K, H)), this.P);
    return { S: S, innov: y };
  };

  /* Doppler update: radar measures range-rate along the unit bearing (ux,uy) */
  KF.prototype.updateRadial = function (rdot, ux, uy, variance) {
    const H = [[0, 0, ux, uy]];
    const pred = H[0][2] * this.x[2][0] + H[0][3] * this.x[3][0];
    const PHt = M.mul(this.P, M.T(H));                 // 4x1
    let s = variance;
    for (let i = 0; i < 4; i++) s += H[0][i] * PHt[i][0];
    const K = PHt.map((r) => [r[0] / s]);
    const innov = rdot - pred;
    for (let i = 0; i < 4; i++) this.x[i][0] += K[i][0] * innov;
    const KH = M.mul(K, H);
    this.P = M.mul(M.sub(M.eye(4), KH), this.P);
  };

  /* squared Mahalanobis distance of a position measurement to this state */
  KF.prototype.mahalanobis2 = function (zx, zy, R) {
    const H = [[1, 0, 0, 0], [0, 1, 0, 0]];
    const S = M.add(M.mul(M.mul(H, this.P), M.T(H)), R);
    const Si = M.inv2(S);
    const dx = zx - this.x[0][0], dy = zy - this.x[1][0];
    return dx * (Si[0][0] * dx + Si[0][1] * dy) + dy * (Si[1][0] * dx + Si[1][1] * dy);
  };

  KF.prototype.pos = function () { return { x: this.x[0][0], y: this.x[1][0], z: 0 }; };
  KF.prototype.vel = function () { return { x: this.x[2][0], y: this.x[3][0], z: 0 }; };
  /* 1-sigma position uncertainty, as the radius of an equivalent-area circle */
  KF.prototype.posSigma = function () { return Math.sqrt(Math.max(0, (this.P[0][0] + this.P[1][1]) / 2)); };
  KF.prototype.velSigma = function () { return Math.sqrt(Math.max(0, (this.P[2][2] + this.P[3][3]) / 2)); };
  /* covariance ellipse of the position block: {a, b, angle} */
  KF.prototype.posEllipse = function () {
    const a = this.P[0][0], b = this.P[0][1], c = this.P[1][1];
    const tr = a + c, det = a * c - b * b;
    const disc = Math.max(0, tr * tr / 4 - det);
    const l1 = tr / 2 + Math.sqrt(disc), l2 = tr / 2 - Math.sqrt(disc);
    const ang = Math.abs(b) < 1e-9 ? (a >= c ? 0 : Math.PI / 2) : Math.atan2(l1 - a, b);
    return { a: Math.sqrt(Math.max(l1, 0)), b: Math.sqrt(Math.max(l2, 0)), angle: ang };
  };

  /* --- log-odds helpers (classification fusion + occupancy) -------------- */
  const logit = (p) => Math.log(clamp(p, 1e-4, 1 - 1e-4) / (1 - clamp(p, 1e-4, 1 - 1e-4)));
  const sigmoid = (l) => 1 / (1 + Math.exp(-l));

  /* --- geometry ---------------------------------------------------------- */
  /* Oriented rectangle corners in world XY for a hull footprint */
  function rectCorners(centre, heading, length, beam) {
    const F = fwd(heading), P = port(heading), hl = length / 2, hb = beam / 2;
    return [
      { x: centre.x + F.x * hl + P.x * hb, y: centre.y + F.y * hl + P.y * hb },
      { x: centre.x + F.x * hl - P.x * hb, y: centre.y + F.y * hl - P.y * hb },
      { x: centre.x - F.x * hl - P.x * hb, y: centre.y - F.y * hl - P.y * hb },
      { x: centre.x - F.x * hl + P.x * hb, y: centre.y - F.y * hl + P.y * hb }
    ];
  }

  /* Separating-axis test for two convex polygons (used for swept-volume conflict) */
  function polysOverlap(A, B) {
    const polys = [A, B];
    for (let p = 0; p < 2; p++) {
      const poly = polys[p];
      for (let i = 0; i < poly.length; i++) {
        const j = (i + 1) % poly.length;
        const nx = -(poly[j].y - poly[i].y), ny = poly[j].x - poly[i].x;
        let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
        for (const q of A) { const d = q.x * nx + q.y * ny; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
        for (const q of B) { const d = q.x * nx + q.y * ny; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
        if (maxA < minB || maxB < minA) return false;
      }
    }
    return true;
  }

  /* Analytic closest point of approach for two constant-velocity bodies */
  function cpa(pA, vA, pB, vB) {
    const rx = pB.x - pA.x, ry = pB.y - pA.y;
    const vx = vB.x - vA.x, vy = vB.y - vA.y;
    const vv = vx * vx + vy * vy;
    if (vv < 1e-9) return { tcpa: 0, cpa: Math.hypot(rx, ry) };
    let t = -(rx * vx + ry * vy) / vv;
    if (t < 0) t = 0;
    const cx = rx + vx * t, cy = ry + vy * t;
    return { tcpa: t, cpa: Math.hypot(cx, cy) };
  }

  NS.math = {
    Rng, clamp, lerp, wrapPi, deg, rad, V, M, KF,
    fwd, port, headingOf, bodyToWorld, worldToBody,
    logit, sigmoid, rectCorners, polysOverlap, cpa
  };
})(window.CORNU);
