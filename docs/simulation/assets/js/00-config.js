/* =============================================================================
   CORNU — Maritime Spatial Intelligence System
   00-config.js — tunable constants. No magic numbers elsewhere.

   COORDINATE SYSTEM (world frame, ENU):
     +X  east      metres
     +Y  north     metres
     +Z  up        metres
     heading  compass bearing, 0 = +Y (north), increasing clockwise (radians)
     forward unit vector = (sin h, cos h, 0)

   BODY FRAME:
     +X  forward (bow)
     +Y  port
     +Z  up
   ========================================================================== */
window.CORNU = window.CORNU || {};

CORNU.CFG = {
  seed: 20260813,

  /* --- update rates (Hz) ------------------------------------------------ */
  rates: {
    physics: 60,        // ground-truth integration
    sensors: 25,        // observation generation
    worldModel: 15,     // association / tracking / fusion / mapping
    risk: 5,            // prediction + risk engine
    ui: 6               // DOM panel refresh
  },

  /* --- own vessel ------------------------------------------------------- */
  ownShip: {
    length: 100, beam: 12.5, airDraft: 6.4, draft: 2.8,
    cruiseSpeed: 3.9,        // m/s ≈ 14 km/h
    maxYawRate: 0.028,       // rad/s
    helmGain: 0.9,           // cross-track → heading demand
    helmDamping: 2.6,
    lookahead: 140,          // m along corridor for the helm target
    laneOffset: 22           // m to starboard of centreline (keep-right)
  },

  /* --- waterway --------------------------------------------------------- */
  waterway: {
    length: 1750,            // m of navigable environment
    baseHalfWidth: 58,
    stations: 240            // centreline sample count
  },

  /* --- perception bands (§6) -------------------------------------------- */
  bands: [
    { max: 30,   label: 'precision manoeuvring' },
    { max: 150,  label: 'high-resolution local' },
    { max: 500,  label: 'long-range radar + vision' },
    { max: 1200, label: 'navigation awareness' }
  ],

  /* --- tracking --------------------------------------------------------- */
  tracking: {
    gateMahalanobis: 4.2,        // association gate (sigma)
    gateMaxMetres: 120,          // hard cap so far tracks cannot swallow near ones
    processNoiseAccel: 0.22,     // m/s^2, drives Q
    initialPosVar: 400,          // m^2
    initialVelVar: 25,           // (m/s)^2
    confirmObservations: 3,      // observations before a track is CONFIRMED
    confidenceDecayPerSec: 0.11, // when unobserved
    confidenceGainPerObs: 0.16,
    dropConfidence: 0.07,        // below this the track is deleted
    predictedAfterSec: 0.8,      // unobserved longer than this → state PREDICTED
    maxCoastSec: 14,             // hard limit on dead reckoning
    mergeDistance: 26,           // m — two tracks this close, moving alike, are one object
    mergeSpeedDelta: 2.2,        // m/s
    spawnSuppression: 26,        // m — do not spawn a track on top of an existing one
    classDimsThreshold: 0.45     // class posterior needed before class dimensions are trusted
  },

  /* --- classification fusion (log-odds) --------------------------------- */
  classes: ['vessel', 'small_craft', 'floating_obstacle', 'buoy', 'bridge_pillar', 'unknown'],

  /* --- prediction ------------------------------------------------------- */
  prediction: {
    horizons: [5, 10, 20, 30, 60],   // s
    step: 2.5,                        // s between swept-volume footprints
    growthPerSec: 0.10,               // m of 1-sigma lateral growth per second
    maxGrowth: 6                      // m — heading uncertainty does not grow without bound
  },

  /* --- risk ------------------------------------------------------------- */
  risk: {
    minConfidence: 0.34,   // below this a track is too weak to drive an alert
    maxRange: 750,         // m — beyond this CPA/TCPA is not actionable
    safetyMargin: 18,      // m clearance the own hull wants around it
    criticalTcpa: 25,      // s
    highTcpa: 60,
    mediumTcpa: 120,
    criticalCpa: 15,       // m
    highCpa: 30,
    mediumCpa: 60,
    bankMargin: 12
  },

  /* --- occupancy grid (vessel-centric, 2.5D log-odds) ------------------- */
  occupancy: {
    halfExtent: 260,   // m each side of the vessel
    cell: 8,           // m
    lFree: -0.42, lOcc: 1.15, lMin: -3.2, lMax: 4.0,
    occThreshold: 0.62, freeThreshold: 0.36
  },

  /* --- palette ---------------------------------------------------------- */
  color: {
    carbon: '#050706', graphite: '#0E1311', panel: '#0A0E0C',
    line: 'rgba(245,246,242,0.10)',
    white: '#F5F6F2', muted: '#79877D', muted2: '#55605A',
    signal: '#C9F26E', water: '#0B1114', bank: '#2A322C',
    risk: { none: '#79877D', low: '#8FA88C', medium: '#E3C55C', high: '#E08A4B', critical: '#E0705F' },
    truth: '#3E4B44'
  }
};
