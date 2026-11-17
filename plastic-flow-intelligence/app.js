(function () {
  'use strict';
  const P = window.PlasticSim;
  const $ = (id) => document.getElementById(id);

  const SHORT = ['Dryer', 'Molding', 'Cooling', 'Trim', 'Packing'];
  const COLORS = { busy: '#2fbf71', starved: '#f5b73b', blocked: '#ef7d3a', down: '#e5484d' };
  const STATUS_LABEL = { busy: 'Running', starved: 'Starved', blocked: 'Blocked', down: 'Down' };
  const CAUSE_LABEL = { stop: 'stoppages', slow: 'running slow', rate: 'rate mismatch' };
  const BUF_COLORS = ['#4aa3ff', '#b78cff', '#f5b73b', '#2fbf71'];

  let preset = 'drift';
  let sim = null;
  let running = true;
  let speed = 30;
  let view = 'system';
  let acc = 0;
  let last = performance.now();

  const f0 = (x) => String(Math.round(x));
  const f1 = (x) => x.toFixed(1);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const pad = (x) => String(x).padStart(2, '0');
  const fmtT = (s) => pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(Math.floor(s % 60));
  const fmtEta = (s) => (s < 90 ? f0(s) + ' s' : f1(s / 60) + ' min');

  /* ---------- derived numbers ---------- */

  function rolling(winSec) {
    const h = sim.hist;
    if (h.length < 2) return 0;
    const end = h[h.length - 1];
    let start = h[0];
    for (let i = h.length - 1; i >= 0; i--) {
      start = h[i];
      if (end.t - h[i].t >= winSec) break;
    }
    const dt = end.t - start.t;
    return dt ? ((end.out - start.out) / dt) * 3600 : 0;
  }

  function localHealth(i) {
    const s = sim.st[i];
    const nominal = sim.cfg.stations[i].ct;
    const avail = sim.t ? 1 - s.acc.down / sim.t : 1;
    const perf = s.recent.length ? Math.min(1, nominal / mean(s.recent)) : 1;
    return { avail, perf, oee: avail * perf, green: avail >= 0.85 && perf >= 0.9 };
  }

  /* ---------- KPIs ---------- */

  function renderKpis(fc) {
    const n = sim.n;
    const ideal = P.theoretical(sim.cfg);
    const ready = sim.t >= 180;
    const out = rolling(600);
    const eff = out / ideal;
    const green = sim.st.filter((_, i) => localHealth(i).green).length;
    const idleMin = sim.constraintIdle / 60;
    const lostTrays = sim.constraintIdle / sim.cfg.stations[sim.constraint].ct;
    const effCls = !ready ? '' : eff >= 0.95 ? 'good' : eff >= 0.85 ? 'warn' : 'bad';
    const riskCls = fc.risk < 30 ? 'good' : fc.risk < 65 ? 'warn' : 'bad';
    const cards = [
      ['Line output (10-min)', ready ? f0(out) + ' trays/h' : '...', ready ? f0(out * P.PARTS_PER_TRAY) + ' parts/h, ideal ' + f0(ideal) + ' trays/h' : 'warming up', ''],
      ['Line efficiency', ready ? f0(eff * 100) + '%' : '...', 'output vs. constraint capacity', effCls],
      ['Machine-level view', green + '/' + n + ' green', 'what machine-level monitors report', green === n ? 'good' : 'warn'],
      ['Hidden loss so far', f0(lostTrays) + ' trays', f0(lostTrays * P.PARTS_PER_TRAY) + ' parts, ' + f1(idleMin) + ' min constraint idle', lostTrays > 20 ? 'warn' : ''],
      ['Disruption risk', fc.risk + ' / 100', fc.alerts.length ? fc.alerts[0].title : 'No imminent disruption', riskCls],
    ];
    $('kpis').innerHTML = cards
      .map((c) => '<div class="kpi ' + c[3] + '"><div class="l">' + c[0] + '</div><div class="v">' + c[1] + '</div><div class="s">' + c[2] + '</div></div>')
      .join('');

    const gapEl = $('gap');
    if (ready) {
      const hidden = Math.max(0, ideal - out);
      gapEl.innerHTML = '<b>Machine view:</b> ' + green + '/' + n + ' machines look healthy. <b>Line view:</b> ' + f0(eff * 100) +
        '% efficiency, about <b>' + f0(hidden) + ' trays/h</b> (' + f0(hidden * P.PARTS_PER_TRAY) + ' parts/h) lost in the gaps between machines.';
    } else {
      gapEl.textContent = 'Collecting data...';
    }
  }

  /* ---------- feature 1: flow map ---------- */

  function renderFlow() {
    const n = sim.n;
    const bx = 135, gapW = 60, x0 = 25, y0 = 55, bh = 130;
    let g = '';
    for (let i = 0; i < n; i++) {
      const s = sim.st[i];
      const x = x0 + i * (bx + gapW);
      const lh = localHealth(i);
      const total = Math.max(1, sim.t);
      let fill, label, l1, l2;
      if (view === 'system') {
        fill = COLORS[s.status];
        label = STATUS_LABEL[s.status];
        const st = f0((100 * s.acc.starved) / total), bl = f0((100 * s.acc.blocked) / total);
        l1 = 'Waiting ' + f0((100 * (s.acc.starved + s.acc.blocked)) / total) + '%';
        l2 = 'starved ' + st + '% / blocked ' + bl + '%';
      } else {
        fill = lh.green ? COLORS.busy : COLORS.starved;
        label = lh.green ? 'Healthy' : 'Check machine';
        l1 = 'Local OEE ' + f0(lh.oee * 100) + '%';
        l2 = 'avail ' + f0(lh.avail * 100) + '% / speed ' + f0(lh.perf * 100) + '%';
      }
      g += '<rect x="' + x + '" y="' + y0 + '" width="' + bx + '" height="' + bh + '" rx="10" fill="' + fill + '" fill-opacity="0.2" stroke="' + fill + '" stroke-width="2"/>';
      g += '<circle cx="' + (x + 16) + '" cy="' + (y0 + 18) + '" r="6" fill="' + fill + '"/>';
      g += '<text x="' + (x + 28) + '" y="' + (y0 + 22) + '" font-size="13" font-weight="700">' + label + '</text>';
      g += '<text x="' + (x + bx / 2) + '" y="' + (y0 + 62) + '" font-size="14" font-weight="600" text-anchor="middle">' + sim.cfg.stations[i].name + '</text>';
      g += '<text x="' + (x + bx / 2) + '" y="' + (y0 + 90) + '" font-size="12" text-anchor="middle">' + l1 + '</text>';
      g += '<text x="' + (x + bx / 2) + '" y="' + (y0 + 108) + '" font-size="11" text-anchor="middle" class="m">' + l2 + '</text>';
      g += '<text x="' + (x + bx / 2) + '" y="' + (y0 - 14) + '" font-size="11" text-anchor="middle" class="m">cycle ' + f1(s.recent.length ? mean(s.recent) : sim.cfg.stations[i].ct) + ' s (nominal ' + f1(sim.cfg.stations[i].ct) + ')</text>';

      if (i < n - 1) {
        const cx = x + bx + gapW / 2;
        const cap = sim.cfg.caps[i], lvl = sim.buf[i];
        const bw = 22, bH = 90, by = y0 + 20;
        const frac = lvl / cap;
        const bc = frac >= 0.99 ? COLORS.blocked : frac <= 0.01 ? COLORS.starved : '#4aa3ff';
        g += '<line x1="' + (x + bx) + '" y1="' + (y0 + bh / 2) + '" x2="' + (x + bx + gapW) + '" y2="' + (y0 + bh / 2) + '" stroke="#3a4a5c" stroke-width="2"/>';
        g += '<rect x="' + (cx - bw / 2) + '" y="' + by + '" width="' + bw + '" height="' + bH + '" rx="4" fill="#0f1419" stroke="#3a4a5c"/>';
        g += '<rect x="' + (cx - bw / 2) + '" y="' + (by + bH * (1 - frac)) + '" width="' + bw + '" height="' + bH * frac + '" rx="4" fill="' + bc + '"/>';
        g += '<text x="' + cx + '" y="' + (by + bH + 16) + '" font-size="11" text-anchor="middle" class="m">' + lvl + '/' + cap + '</text>';
      }
    }
    $('flow').innerHTML = g;
  }

  /* ---------- feature 2: hidden-loss attribution ---------- */

  function renderMatrix() {
    const n = sim.n;
    let max = 1;
    sim.matrix.forEach((r) => r.forEach((v) => { if (v > max) max = v; }));
    let h = '<table class="heat"><tr><th>Cause \\ Affected</th>' + SHORT.map((s) => '<th>' + s + '</th>').join('') + '</tr>';
    for (let r = 0; r < n; r++) {
      h += '<tr><td>' + SHORT[r] + '</td>';
      for (let c = 0; c < n; c++) {
        if (r === c) { h += '<td class="c muted">-</td>'; continue; }
        const v = sim.matrix[r][c];
        const a = (0.75 * v) / max;
        h += '<td class="c" style="background:rgba(239,125,58,' + a.toFixed(2) + ')">' + (v ? f1(v / 60) : '0') + '</td>';
      }
      h += '</tr>';
    }
    $('matrix').innerHTML = h + '</table>';

    // constraint loss by root cause
    const rows = Object.keys(sim.lossByKey)
      .map((k) => { const p = k.split('|'); return { root: +p[0], cause: p[1], sec: sim.lossByKey[k] }; })
      .sort((a, b) => b.sec - a.sec)
      .slice(0, 6);
    const total = sim.constraintIdle || 1;
    const ct = sim.cfg.stations[sim.constraint].ct;
    $('loss').innerHTML = rows.length
      ? '<div class="bars">' + rows.map((r) =>
          '<div class="r"><span>' + (r.root === sim.constraint ? 'Own ' : '') + SHORT[r.root] + ' ' + CAUSE_LABEL[r.cause] +
          '</span><div class="b"><div style="width:' + f0((100 * r.sec) / total) + '%"></div></div><span>' +
          f1(r.sec / 60) + ' min, ' + f0(r.sec / ct) + ' trays</span></div>').join('') + '</div>'
      : '<span class="muted">No loss recorded yet.</span>';

    // insights
    const cells = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (r !== c && sim.matrix[r][c] > 0) cells.push({ r, c, v: sim.matrix[r][c] });
    cells.sort((a, b) => b.v - a.v);
    const ins = cells.filter((x) => x.v >= 60).slice(0, 3).map((x) => {
      const how = x.r < x.c ? 'starvation from upstream' : 'back-pressure from downstream';
      return '<li><b>' + sim.cfg.stations[x.r].name + '</b> cost <b>' + sim.cfg.stations[x.c].name + '</b> ' + f1(x.v / 60) +
        ' min of waiting via ' + how + '. Neither machine\'s own status shows this.</li>';
    });
    $('insights').innerHTML = ins.length ? ins.join('') : '<li class="muted">Insights appear after a few minutes of data.</li>';

    // ledger
    let L = '<table><tr><th>Station</th><th>Stops</th><th>Micro (&lt;60 s)</th><th>Avg stop</th><th>Down time</th><th>Local avail.</th></tr>';
    sim.st.forEach((s, i) => {
      const lh = localHealth(i);
      L += '<tr><td>' + SHORT[i] + '</td><td>' + s.stops.count + '</td><td>' + s.stops.micro + '</td><td>' +
        (s.stops.count ? f0(s.stops.total / s.stops.count) + ' s' : '-') + '</td><td>' + f1(s.acc.down / 60) + ' min</td><td>' + f0(lh.avail * 100) + '%</td></tr>';
    });
    $('ledger').innerHTML = L + '</table>';
  }

  /* ---------- feature 3: early warning ---------- */

  function renderAlerts(fc) {
    const fill = $('riskFill');
    fill.style.width = fc.risk + '%';
    fill.style.background = fc.risk < 30 ? 'var(--good)' : fc.risk < 65 ? 'var(--warn)' : 'var(--bad)';
    $('riskNum').textContent = fc.risk;
    if (!fc.alerts.length) {
      $('alerts').innerHTML = '<li class="ok"><b>No imminent disruption detected</b><span>Buffers are stable and no machine is drifting. Needs about 7 simulated minutes of data.</span></li>';
      return;
    }
    $('alerts').innerHTML = fc.alerts.slice(0, 4).map((a) =>
      '<li class="' + (a.sev === 'high' ? 'high' : '') + '"><b>' + a.title + (a.kind !== 'drift' && a.eta > 0 ? ' in ~' + fmtEta(a.eta) : '') + '</b><span>' + a.detail + '</span></li>').join('');
  }

  function setupCanvas(c) {
    const r = c.getBoundingClientRect();
    const d = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(r.width * d)), h = Math.max(10, Math.round(r.height * d));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.setTransform(d, 0, 0, d, 0, 0);
    return { g, w: r.width, h: r.height };
  }

  function drawLines(canvas, series, o) {
    const { g, w, h } = setupCanvas(canvas);
    g.clearRect(0, 0, w, h);
    const L = 34, R = 10, T = 14, B = 22;
    g.font = '11px system-ui, sans-serif';
    g.strokeStyle = '#2a3644'; g.fillStyle = '#8b9bab'; g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const y = T + ((h - T - B) * k) / 4;
      g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke();
      g.fillText(f0(o.max - ((o.max - o.min) * k) / 4), 4, y + 4);
    }
    const len = Math.max.apply(null, series.map((s) => s.data.length));
    if (len < 2) { g.fillText('collecting data...', L + 10, h / 2); return; }
    const X = (i) => L + ((w - L - R) * i) / (o.span ? o.span - 1 : len - 1);
    const Y = (v) => T + (h - T - B) * (1 - (v - o.min) / (o.max - o.min));
    if (o.ref != null) {
      g.setLineDash([5, 4]); g.strokeStyle = '#8b9bab';
      g.beginPath(); g.moveTo(L, Y(o.ref)); g.lineTo(w - R, Y(o.ref)); g.stroke(); g.setLineDash([]);
    }
    series.forEach((s) => {
      g.strokeStyle = s.color; g.lineWidth = 2; g.beginPath();
      const off = o.span ? o.span - s.data.length : 0;
      s.data.forEach((v, i) => { const x = X(i + off), y = Y(v); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
      g.stroke();
    });
    let lx = L;
    series.forEach((s) => {
      g.fillStyle = s.color; g.fillRect(lx, h - 12, 10, 3);
      g.fillStyle = '#8b9bab'; g.fillText(s.name, lx + 14, h - 7);
      lx += 14 + g.measureText(s.name).width + 14;
    });
  }

  function renderCharts() {
    const h = sim.hist.slice(-60);
    const series = [];
    for (let b = 0; b < sim.n - 1; b++) {
      series.push({ name: 'after ' + SHORT[b], color: BUF_COLORS[b], data: h.map((x) => x.buf[b]) });
    }
    drawLines($('cBuf'), series, { min: 0, max: 8, span: 60 });

    const all = sim.hist.slice(-270);
    const pts = [];
    let j = 0;
    for (let i = 0; i < all.length; i++) {
      while (j < i && all[i].t - all[j].t > 300) j++;
      const dt = all[i].t - all[j].t;
      if (dt >= 60) pts.push(((all[i].out - all[j].out) / dt) * 3600);
    }
    const ideal = P.theoretical(sim.cfg);
    drawLines($('cOut'), [{ name: 'trays/h', color: '#4aa3ff', data: pts.slice(-240) }], { min: Math.floor(ideal * 0.6 / 100) * 100, max: Math.ceil(ideal / 100) * 100, ref: ideal });
  }

  /* ---------- feature 4: ripple what-if ---------- */

  function renderWhatIf(r) {
    const name = sim.cfg.stations[r.station].name;
    const kind = r.type === 'stop' ? 'full stop' : 'slowdown';
    let h = '<div class="kpi warn" style="margin-bottom:10px"><div class="l">' + name + ' ' + kind + ' for ' + f0(r.durationSec / 60) +
      ' min</div><div class="v">-' + f0(r.lostTrays) + ' trays</div><div class="s">' + f0(r.lostTrays * P.PARTS_PER_TRAY) +
      ' parts lost over 1 h (' + f0(r.baseOut) + ' to ' + f0(r.evOut) + ' trays)</div></div>';
    h += '<table><tr><th>Station</th><th>Extra waiting</th><th>Output starts lagging</th></tr>';
    r.idleDeltaMin.forEach((d, i) => {
      let lag;
      if (i === r.station) lag = '<span class="pill">origin</span>';
      else if (r.lagAt[i] === null) lag = '<span class="pill">absorbed by buffers</span>';
      else lag = '+' + fmtEta(r.lagAt[i]);
      h += '<tr><td>' + SHORT[i] + '</td><td>' + (d >= 0 ? '+' : '') + f1(d) + ' min</td><td>' + lag + '</td></tr>';
    });
    h += '</table><p class="muted">Lagging means cumulative output falls at least 3 trays behind the undisturbed twin run. It shows how fast the disruption travels through the buffers.</p>';
    $('wiOut').innerHTML = h;
  }

  function runWhatIf() {
    const i = +$('wiStation').value;
    const mins = +$('wiMag').value;
    $('wiOut').innerHTML = '<span class="muted">Simulating...</span>';
    setTimeout(() => {
      const cfg = P.cloneCfg(sim.cfg, { events: [], tOffset: sim.t });
      renderWhatIf(P.whatIf(cfg, { station: i, type: $('wiType').value, factor: 1.4, durationSec: mins * 60 }));
    }, 20);
  }

  function injectLive() {
    const i = +$('wiStation').value;
    const dur = +$('wiMag').value * 60;
    sim.cfg.events.push({ station: sim.cfg.stations[i].id, type: $('wiType').value, factor: 1.4, start: sim.t + 1, end: sim.t + 1 + dur });
    $('wiOut').innerHTML = '<div class="alerts"><li><b>Injected into the live line</b><span>Watch the flow map, attribution matrix and early-warning panel react over the next minutes (speed it up if needed).</span></li></div>';
  }

  /* ---------- feature 5: improvement ranking ---------- */

  function runSensitivity() {
    $('senOut').innerHTML = '<span class="muted">Simulating 15 levers x 3 runs...</span>';
    setTimeout(() => {
      const t0 = performance.now();
      const cfg = P.cloneCfg(sim.cfg, { events: [] });
      const res = P.sensitivity(cfg, { tOffset: sim.t });
      const max = Math.max(1, res.rows[0].gain);
      let h = '<div class="bars">' + res.rows.slice(0, 8).map((r, i) =>
        '<div class="r"><span>' + (i + 1) + '. ' + r.label + '</span><div class="b g"><div style="width:' + f0((100 * Math.max(0, r.gain)) / max) +
        '%"></div></div><span>+' + f0(Math.max(0, r.gain)) + ' trays/h (+' + f1(r.pct) + '%)</span></div>').join('') + '</div>';
      const slowest = sim.cfg.stations.reduce((b, s, i, a) => (s.ct > a[b].ct ? i : b), 0);
      const k = res.rows.findIndex((r) => r.label.indexOf(sim.cfg.stations[slowest].name + ': cycle time') === 0);
      h += '<p class="muted">Baseline ' + f0(res.baseRate) + ' trays/h. The obvious move, speeding up the slowest machine (' + sim.cfg.stations[slowest].name +
        '), ranks #' + (k + 1) + ' of ' + res.rows.length + '. Gain figures are simulation averages over 3 random seeds, so differences of a few trays/h are within noise.</p>';
      $('senOut').innerHTML = h;
      $('senNote').textContent = 'from sim time ' + fmtT(sim.t) + ' (' + f0(performance.now() - t0) + ' ms)';
    }, 20);
  }

  /* ---------- wiring ---------- */

  function render() {
    const fc = P.forecast(sim);
    $('clock').textContent = 'Sim time ' + fmtT(sim.t);
    renderKpis(fc);
    renderFlow();
    renderMatrix();
    renderAlerts(fc);
    renderCharts();
  }

  function resetSim() {
    sim = new P.Sim(P.makeConfig(preset), 7);
    acc = 0;
    $('wiOut').innerHTML = '';
    $('senOut').innerHTML = '';
    $('senNote').textContent = '';
    render();
    runSensitivity();
  }

  function init() {
    $('preset').innerHTML = Object.keys(P.PRESETS).map((k) => '<option value="' + k + '">' + P.PRESETS[k].label + '</option>').join('');
    const names = P.makeConfig('drift').stations.map((s) => s.name);
    $('wiStation').innerHTML = names.map((n, i) => '<option value="' + i + '"' + (i === 4 ? ' selected' : '') + '>' + n + '</option>').join('');

    $('preset').addEventListener('change', (e) => { preset = e.target.value; resetSim(); });
    $('speed').addEventListener('change', (e) => { speed = +e.target.value; });
    $('play').addEventListener('click', () => { running = !running; $('play').textContent = running ? 'Pause' : 'Resume'; });
    $('reset').addEventListener('click', resetSim);
    $('vSystem').addEventListener('click', () => { view = 'system'; $('vSystem').classList.add('on'); $('vLocal').classList.remove('on'); renderFlow(); });
    $('vLocal').addEventListener('click', () => { view = 'local'; $('vLocal').classList.add('on'); $('vSystem').classList.remove('on'); renderFlow(); });
    $('wiMag').addEventListener('input', (e) => { $('wiMagVal').textContent = e.target.value + ' min'; });
    $('wiRun').addEventListener('click', runWhatIf);
    $('wiLive').addEventListener('click', injectLive);
    $('senRun').addEventListener('click', runSensitivity);
    window.addEventListener('resize', renderCharts);

    resetSim();
    setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.5, (now - last) / 1000);
      last = now;
      if (running) {
        acc += dt * speed;
        const k = Math.floor(acc);
        acc -= k;
        for (let i = 0; i < k; i++) sim.step();
      }
      render();
    }, 200);
  }

  init();
})();
