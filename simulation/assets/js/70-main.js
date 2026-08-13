/* =============================================================================
   70-main.js — the loop.

   Each stage runs at its own rate (§36):
     physics 60 Hz · sensors 25 Hz · world model 15 Hz · risk 5 Hz · UI 6 Hz
   Rendering runs on requestAnimationFrame and always draws the latest model.
   ========================================================================== */
(function (NS) {
  'use strict';
  const CFG = NS.CFG;

  function App() {
    this.canvas = document.getElementById('scene');
    this.renderer = new NS.rendering.Renderer(this.canvas);
    this.viewMode = 'blend';
    this.timeScale = 1;
    this.running = true;
    this.scenarioId = 'normal';
    this.fps = 0; this.wmHz = 0; this.sensorHz = 0;
    this._acc = { sensors: 0, wm: 0, ui: 0 };
    this._counters = { wm: 0, sensors: 0, frames: 0, t: 0 };
    this.simTime = 0;
    this.recentObs = [];

    this.loadScenario('normal');
    this.ui = new NS.ui.UI(this);

    window.addEventListener('resize', () => this.renderer.resize());
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  App.prototype.loadScenario = function (id) {
    this.scenarioId = id;
    this.world = new NS.world.World(id);
    this.provider = new NS.sensors.SimulationPerceptionProvider(this.world);
    this.wm = new NS.worldmodel.WorldModel(this.provider);
    this.simTime = 0;
    this.recentObs = [];
    this.renderer.selectedId = null;
    const insp = document.getElementById('inspector');
    if (insp) insp.classList.remove('open');
    /* prime the model so the first frame is not empty */
    for (let i = 0; i < 40; i++) this.stepSim(1 / 30);
  };

  /* one simulation step at dt seconds of simulated time */
  App.prototype.stepSim = function (dt) {
    const physicsStep = 1 / CFG.rates.physics;
    let remaining = dt;
    while (remaining > 1e-6) {
      const h = Math.min(physicsStep, remaining);
      this.world.step(h);
      remaining -= h;
    }
    this.simTime += dt;

    /* --- sensors --------------------------------------------------------- */
    this._acc.sensors += dt;
    const sensorPeriod = 1 / CFG.rates.sensors;
    let observations = [], structural = [];
    while (this._acc.sensors >= sensorPeriod) {
      this._acc.sensors -= sensorPeriod;
      observations = observations.concat(
        this.provider.getObservations(sensorPeriod, this.simTime));
      structural = structural.concat(
        this.provider.getStructuralObservations(sensorPeriod, this.simTime));
      this._counters.sensors++;
    }

    /* keep a short window of raw observations for the debug layer */
    if (observations.length) {
      for (const o of observations) this.recentObs.push(o);
    }
    for (const o of this.recentObs) o._age = this.simTime - o.timestamp;
    this.recentObs = this.recentObs.filter((o) => o._age < 1.2);
    if (this.recentObs.length > 900) this.recentObs.splice(0, this.recentObs.length - 900);
    this.provider.recentObservations = this.recentObs;

    /* --- world model ------------------------------------------------------ */
    this._acc.wm += dt;
    const wmPeriod = 1 / CFG.rates.worldModel;
    if (this._acc.wm >= wmPeriod || observations.length || structural.length) {
      const step = Math.max(this._acc.wm, 1e-3);
      this._acc.wm = 0;
      const ego = this.provider.getEgoState(this.simTime);
      this.wm.update(observations, structural, ego, step, this.simTime);
      this._counters.wm++;
    }
  };

  App.prototype.frame = function (now) {
    const realDt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;

    if (this.running) this.stepSim(realDt * this.timeScale);

    this.renderer.render(this.wm, this.provider, this.world, realDt, this.viewMode);

    /* --- rate meters ------------------------------------------------------ */
    this._counters.frames++;
    this._counters.t += realDt;
    if (this._counters.t >= 0.5) {
      this.fps = this._counters.frames / this._counters.t;
      this.wmHz = this._counters.wm / this._counters.t;
      this.sensorHz = this._counters.sensors / this._counters.t;
      this._counters = { wm: 0, sensors: 0, frames: 0, t: 0 };
    }

    /* --- UI --------------------------------------------------------------- */
    this._acc.ui += realDt;
    if (this._acc.ui >= 1 / CFG.rates.ui) {
      this._acc.ui = 0;
      try { this.ui.update(this.wm, this.provider, this); }
      catch (err) { console.error('UI update failed', err); }
    }

    requestAnimationFrame((t) => this.frame(t));
  };

  window.addEventListener('DOMContentLoaded', () => {
    try {
      window.CORNU.app = new App();
    } catch (err) {
      console.error('CORNU failed to start', err);
      const b = document.getElementById('bootError');
      if (b) { b.style.display = 'block'; b.textContent = 'Failed to start: ' + err.message; }
    }
  });

  NS.App = App;
})(window.CORNU);
