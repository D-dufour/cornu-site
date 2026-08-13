/* =============================================================================
   60-ui.js — OPERATOR INTERFACE.
   Reads the world model only; writes nothing back except operator commands.
   ========================================================================== */
(function (NS) {
  'use strict';
  const { V, deg, clamp } = NS.math;
  const C = NS.CFG.color;

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined) n.textContent = txt;
    return n;
  };

  function UI(app) {
    this.app = app;
    this.build();
  }

  UI.prototype.build = function () {
    const app = this.app;

    /* --- camera + view mode --------------------------------------------- */
    this.bindGroup('#camModes', (v) => { app.renderer.camera.mode = v; });
    this.bindGroup('#viewModes', (v) => {
      app.viewMode = v;
      /* the two comparison views of §22 are layer presets, not new cameras */
      const L = app.renderer.layers;
      if (v === 'model') { L.decor = false; L.groundTruth = false; }
      if (v === 'blend') { L.decor = true;  L.groundTruth = false; }
      if (v === 'truth') { L.decor = true;  L.groundTruth = true; }
      this.syncLayerChecks();
    });
    this.bindGroup('#density', (v) => {
      const R = app.renderer;
      R.dense = v === 'dense';
      const preset = R.presets[v];
      for (const k in preset) R.layers[k] = !!preset[k];
      if (app.viewMode === 'truth') R.layers.groundTruth = true;
      this.syncLayerChecks();
    });
    this.bindGroup('#speeds', (v) => { app.timeScale = parseFloat(v); });
    this.bindGroup('#scenarios', (v) => { app.loadScenario(v); });

    $('#playPause').addEventListener('click', () => {
      app.running = !app.running;
      $('#playPause').textContent = app.running ? 'Pause' : 'Play';
      $('#playPause').classList.toggle('on', app.running);
    });
    $('#reset').addEventListener('click', () => app.loadScenario(app.scenarioId));

    /* --- layer toggles ---------------------------------------------------- */
    const layerDefs = [
      ['semantic', 'Semantic objects'], ['ids', 'Object IDs'],
      ['predictions', 'Predictions'], ['corridor', 'Navigation corridor'],
      ['swept', 'Swept volume'], ['occupancy', 'Occupancy grid'],
      ['rawObs', 'Raw observations'], ['frustums', 'Sensor frustums'],
      ['uncertainty', 'Uncertainty'], ['history', 'Track history'],
      ['groundTruth', 'Ground truth'], ['ranges', 'Range rings']
    ];
    const wrap = $('#layers');
    this.layerInputs = {};
    layerDefs.forEach(([key, label]) => {
      const row = el('label', 'chk');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = !!app.renderer.layers[key];
      box.addEventListener('change', () => { app.renderer.layers[key] = box.checked; });
      row.appendChild(box);
      row.appendChild(el('span', null, label));
      wrap.appendChild(row);
      this.layerInputs[key] = box;
    });

    /* --- canvas interaction ---------------------------------------------- */
    const cv = app.canvas;
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, moved: 0 };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = e.clientX; drag.y = e.clientY;
      const o = app.renderer.camera.orbit;
      o.yaw = o.yaw - dx * 0.006;
      o.pitch = clamp(o.pitch + dy * 0.004, -0.45, 1.2);
    });
    cv.addEventListener('pointerup', (e) => {
      if (drag && drag.moved < 5) {
        const r = cv.getBoundingClientRect();
        const hit = app.renderer.pick(e.clientX - r.left, e.clientY - r.top);
        app.renderer.selectedId = hit ? hit.id : null;
        this.renderInspector(hit);
      }
      drag = null;
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const o = app.renderer.camera.orbit;
      o.dist = clamp(o.dist * (1 + Math.sign(e.deltaY) * 0.12), 0.35, 4);
    }, { passive: false });

    $('#inspectorClose').addEventListener('click', () => {
      app.renderer.selectedId = null;
      $('#inspector').classList.remove('open');
    });
  };

  UI.prototype.bindGroup = function (sel, fn) {
    const group = document.querySelector(sel);
    if (!group) return;
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      group.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      fn(b.dataset.v);
    });
  };

  UI.prototype.syncLayerChecks = function () {
    for (const k in this.layerInputs) this.layerInputs[k].checked = !!this.app.renderer.layers[k];
  };

  /* -----------------------------------------------------------------------
     Live panels
     -------------------------------------------------------------------- */
  UI.prototype.update = function (wm, provider, app) {
    const own = wm.getOwnVessel();
    if (!own) return;

    /* header */
    $('#clock').textContent = fmtTime(wm.time);
    const risk = wm.overallRisk();
    const badge = $('#riskBadge');
    badge.textContent = 'RISK ' + risk.toUpperCase();
    badge.style.color = C.risk[risk];
    badge.style.borderColor = hexA(C.risk[risk], 0.45);

    /* vessel status */
    const rows = [
      ['Speed', (own.speed * 3.6).toFixed(1) + ' km/h'],
      ['Heading', String(Math.round((deg(own.heading) + 360) % 360)).padStart(3, '0') + '°'],
      ['Yaw rate', (deg(own.yawRate)).toFixed(2) + ' °/s'],
      ['Position X', own.position.x.toFixed(1) + ' m'],
      ['Position Y', own.position.y.toFixed(1) + ' m'],
      ['Pos. σ', '±' + own.positionUncertainty.toFixed(2) + ' m'],
      ['Length', own.dimensions.length.toFixed(0) + ' m'],
      ['Beam', own.dimensions.beam.toFixed(1) + ' m'],
      ['Air draft', own.dimensions.height.toFixed(1) + ' m']
    ];
    this.fillRows('#vesselRows', rows);

    /* perception summary */
    const ents = wm.getEntities();
    const byClass = {};
    ents.forEach((e) => { byClass[e.semanticClass] = (byClass[e.semanticClass] || 0) + 1; });
    const tracked = ents.filter((e) => e.state === 'TRACKED').length;
    const predicted = ents.filter((e) => e.state === 'PREDICTED').length;
    const tentative = ents.filter((e) => e.state === 'TENTATIVE').length;

    let closest = null;
    for (const e of ents) {
      const d = V.dist2d(e.position, own.position);
      if (!closest || d < closest.d) closest = { d, e };
    }
    const cor = wm.getNavigableSpace();
    const bridge = wm.getBridgeState();
    /* report the CPA that actually carries risk, not the closest buoy */
    let worstCpa = null;
    for (const r of wm.getRisks()) {
      if (r.tcpa <= 0.05 || r.level === 'none') continue;
      if (!worstCpa || r.cpa < worstCpa.cpa) worstCpa = r;
    }

    this.fillRows('#perceptRows', [
      ['Entities', String(ents.length)],
      ['Tracked', String(tracked)],
      ['Predicted', String(predicted)],
      ['Tentative', String(tentative)],
      ['Vessels', String(byClass.vessel || 0)],
      ['Small craft', String(byClass.small_craft || 0)],
      ['Obstacles', String(byClass.floating_obstacle || 0)],
      ['Buoys', String(byClass.buoy || 0)],
      ['Unclassified', String(byClass.unknown || 0)],
      ['Observations/s', String(provider.stats.perSecond)],
      ['Map cells', String(wm.staticMap.cells.size)],
      ['Occupancy cells', String(wm.occupancy.cells.size)]
    ]);

    this.fillRows('#navRows', [
      ['Closest object', closest ? closest.d.toFixed(0) + ' m  ' + closest.e.id : '—'],
      ['Corridor ahead', cor ? cor.widthAhead.toFixed(0) + ' m' : '—'],
      ['Corridor min', cor ? cor.minWidth.toFixed(0) + ' m' : '—'],
      ['Next bridge', bridge ? bridge.id : 'none detected'],
      ['Bridge range', bridge && bridge.range ? bridge.range.toFixed(0) + ' m' : '—'],
      ['Clearance', bridge ? bridge.clearance.toFixed(2) + ' m' : '—'],
      ['Required', bridge ? bridge.required.toFixed(2) + ' m' : '—'],
      ['Opening', bridge ? bridge.openingWidth.toFixed(1) + ' m' : '—'],
      ['Bridge conf.', bridge ? (bridge.confidence * 100).toFixed(0) + '%' : '—'],
      ['CPA', worstCpa ? worstCpa.cpa.toFixed(1) + ' m' : '—'],
      ['TCPA', worstCpa ? worstCpa.tcpa.toFixed(0) + ' s' : '—']
    ]);

    this.fillRows('#perfRows', [
      ['Sim FPS', app.fps.toFixed(0)],
      ['World model', app.wmHz.toFixed(0) + ' Hz'],
      ['Sensor sim', app.sensorHz.toFixed(0) + ' Hz'],
      ['Updates', String(wm.updateCount)],
      ['Observations', String(wm.observationCount)]
    ]);

    /* sensors */
    const st = provider.status();
    const wrap = $('#sensorRows');
    wrap.textContent = '';
    st.forEach((s) => {
      const row = el('div', 'srow');
      row.appendChild(el('span', 'sid', s.id));
      const badge2 = el('span', 'sstate ' + s.state.toLowerCase(), s.state);
      row.appendChild(badge2);
      wrap.appendChild(row);
    });

    /* alerts */
    const ab = $('#alerts');
    ab.textContent = '';
    if (!wm.alerts.length) {
      const n = el('div', 'alert none');
      n.appendChild(el('span', 'lvl', 'CLEAR'));
      n.appendChild(el('span', 'txt', 'No conflicts predicted in the next 60 s'));
      ab.appendChild(n);
    } else {
      wm.alerts.slice(0, 4).forEach((a) => {
        const n = el('div', 'alert ' + a.level);
        n.appendChild(el('span', 'lvl', a.level.toUpperCase()));
        n.appendChild(el('span', 'txt', a.text));
        ab.appendChild(n);
      });
    }

    /* keep an open inspector live */
    if (this.app.renderer.selectedId) {
      const e = ents.find((x) => x.id === this.app.renderer.selectedId);
      if (e) this.renderInspector(e, true);
    }
  };

  UI.prototype.fillRows = function (sel, rows) {
    const wrap = document.querySelector(sel);
    if (!wrap) return;
    if (wrap.childElementCount !== rows.length) {
      wrap.textContent = '';
      rows.forEach(() => {
        const r = el('div', 'row');
        r.appendChild(el('span', 'k'));
        r.appendChild(el('span', 'v'));
        wrap.appendChild(r);
      });
    }
    rows.forEach(([k, v], i) => {
      const r = wrap.children[i];
      if (r.children[0].textContent !== k) r.children[0].textContent = k;
      if (r.children[1].textContent !== v) r.children[1].textContent = v;
    });
  };

  /* --- entity inspector (§43) --------------------------------------------- */
  UI.prototype.renderInspector = function (e, quiet) {
    const box = $('#inspector');
    if (!e) { box.classList.remove('open'); return; }
    box.classList.add('open');
    $('#inspTitle').textContent = e.id;
    const risk = e.riskLevel || 'none';
    const r = (this.app.wm.getRisks() || []).find((x) => x.entityId === e.id) || {};

    const rows = [
      ['Class', NS.rendering.labelFor(e)],
      ['State', e.state],
      ['Position X', e.position.x.toFixed(1) + ' m'],
      ['Position Y', e.position.y.toFixed(1) + ' m'],
      ['Speed', e.speed.toFixed(2) + ' m/s'],
      ['Heading', String(Math.round((deg(e.heading) + 360) % 360)).padStart(3, '0') + '°'],
      ['Confidence', (e.confidence * 100).toFixed(1) + '%'],
      ['Position σ', '±' + e.positionUncertainty.toFixed(2) + ' m'],
      ['Velocity σ', '±' + e.velocityUncertainty.toFixed(2) + ' m/s'],
      ['Dimensions', e.dimensions.length.toFixed(0) + ' × ' + e.dimensions.beam.toFixed(1) + ' m'],
      ['Observations', String(e.observationCount)],
      ['Track age', e.ageSeconds.toFixed(1) + ' s'],
      ['Last seen', e.staleSeconds.toFixed(1) + ' s ago'],
      ['CPA', r.cpa !== undefined ? r.cpa.toFixed(1) + ' m' : '—'],
      ['TCPA', r.tcpa !== undefined ? r.tcpa.toFixed(1) + ' s' : '—'],
      ['Risk', risk.toUpperCase()]
    ];
    this.fillRows('#inspRows', rows);

    const src = $('#inspSources');
    src.textContent = '';
    e.contributingSensors.forEach((s) => src.appendChild(el('span', 'src', s)));
    void quiet;
  };

  function fmtTime(t) {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function hexA(hex, a) {
    const h = hex.replace('#', '');
    return 'rgba(' + parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' +
      parseInt(h.slice(4, 6), 16) + ',' + a + ')';
  }

  NS.ui = { UI };
})(window.CORNU);
