/*
 * Plastic Flow Intelligence - simulation + analytics engine
 * Scenario: injection-molding Line 3 (Dryer -> Molding -> Cooling -> Trim/Inspect -> Packaging)
 * One "unit" = one tray of parts (20 parts). Time step = 1 second.
 * Works in the browser (window.PlasticSim) and in Node (module.exports) for tests.
 */
(function (root) {
  'use strict';

  const PARTS_PER_TRAY = 20;

  const BASE_STATIONS = [
    { id: 'dryer',   name: 'Resin Dryer',       ct: 3.0, mtbf: 1400, mttr: 25 },
    { id: 'molding', name: 'Injection Molding', ct: 4.0, mtbf: 1100, mttr: 30 },
    { id: 'cooling', name: 'Cooling Conveyor',  ct: 3.4, mtbf: 500,  mttr: 20 },
    { id: 'trim',    name: 'Trim & Inspect',    ct: 3.6, mtbf: 700,  mttr: 25 },
    { id: 'pack',    name: 'Packaging',         ct: 3.2, mtbf: 380,  mttr: 28 },
  ];
  // buffers sit AFTER stations 0..3 (hopper, mold output, cooling exit, trim exit)
  const BASE_CAPS = [8, 5, 5, 6];

  const PRESETS = {
    drift: {
      label: 'Hidden dryer drift + micro-stops (default)',
      driftRate: 0.40, // dryer cycle time grows 40% per hour (moisture sensor drift)
      mods: {},
    },
    cascade: {
      label: 'Packaging micro-stop cascade',
      driftRate: 0,
      caps: [8, 3, 3, 3], // small downstream buffers: nothing absorbs the packaging stops
      mods: { pack: { mtbf: 110, mttr: 15 } },
    },
    healthy: {
      label: 'Healthy reference line',
      driftRate: 0,
      mods: { dryer: { mttr: 12 }, molding: { mttr: 15 }, cooling: { mttr: 10 }, trim: { mttr: 12 }, pack: { mttr: 14 } },
    },
  };

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeConfig(key) {
    const p = PRESETS[key] || PRESETS.drift;
    const stations = BASE_STATIONS.map((s) => Object.assign({}, s, (p.mods && p.mods[s.id]) || {}));
    return {
      stations,
      caps: (p.caps || BASE_CAPS).slice(),
      drift: { station: 'dryer', ratePerHour: p.driftRate },
      events: [],
      tOffset: 0,
    };
  }

  function cloneCfg(cfg, patch) {
    return Object.assign(JSON.parse(JSON.stringify(cfg)), patch || {});
  }

  function theoretical(cfg) {
    return 3600 / Math.max.apply(null, cfg.stations.map((s) => s.ct));
  }

  class Sim {
    constructor(cfg, seed, opts) {
      opts = opts || {};
      this.cfg = cloneCfg(cfg);
      this.seed = seed == null ? 7 : seed;
      const n = (this.n = this.cfg.stations.length);
      // one random stream per station: a disruption in one place cannot change the
      // random draws of other stations, so what-if comparisons show only causal effects
      this.rands = this.cfg.stations.map((_, i) => mulberry32(this.seed * 1000 + i * 7919 + 13));
      this.t = 0;
      this.out = 0;
      this.buf = [4, 2, 2, 3].slice(0, n - 1);
      this.constraint = this.cfg.stations.reduce((b, s, i, a) => (s.ct > a[b].ct ? i : b), 0);
      this.constraintIdle = 0;
      this.matrix = Array.from({ length: n }, () => new Array(n).fill(0));
      this.lossByKey = {};
      this.hist = [];
      this.ctHist = this.cfg.stations.map(() => []);
      this.st = this.cfg.stations.map((d, i) => ({
        status: 'starved', remaining: 0, hasItem: false, carry: 0, downLeft: 0,
        ttf: this.expo(d.mtbf, i), inDown: false, downStart: 0, curCt: d.ct, recent: [],
        done: 0,
        acc: { busy: 0, starved: 0, blocked: 0, down: 0 },
        stops: { count: 0, total: 0, micro: 0 },
      }));
    }

    expo(m, i) { return -Math.log(1 - this.rands[i]()) * m; }

    activeEvent(i, type) {
      const id = this.cfg.stations[i].id;
      const ev = this.cfg.events;
      for (let k = 0; k < ev.length; k++) {
        const e = ev[k];
        if (e.station === id && e.type === type && this.t >= e.start && this.t < e.end) return e;
      }
      return null;
    }

    cycleTime(i) {
      const d = this.cfg.stations[i];
      let m = 1;
      const dr = this.cfg.drift;
      if (dr && dr.station === d.id) m += dr.ratePerHour * ((this.t + (this.cfg.tOffset || 0)) / 3600);
      const ev = this.activeEvent(i, 'slow');
      if (ev) m *= ev.factor;
      return d.ct * m * (1 + (this.rands[i]() - 0.5) * 0.08);
    }

    push(i) {
      const s = this.st[i];
      if (i === this.n - 1) { this.out++; s.hasItem = false; return true; }
      if (this.buf[i] < this.cfg.caps[i]) { this.buf[i]++; s.hasItem = false; return true; }
      return false;
    }

    take(i) {
      if (i === 0) return true; // dryer has unlimited raw resin
      if (this.buf[i - 1] > 0) { this.buf[i - 1]--; return true; }
      return false;
    }

    work(i) {
      const s = this.st[i];
      const d = this.cfg.stations[i];
      if (s.hasItem && s.remaining <= 0) {
        if (!this.push(i)) { s.carry = 0; return 'blocked'; }
      }
      if (!s.hasItem) {
        if (!this.take(i)) { s.carry = 0; return 'starved'; }
        const ct = this.cycleTime(i);
        s.curCt = ct; s.remaining = ct + s.carry; s.carry = 0; s.hasItem = true;
      }
      s.remaining -= 1;
      s.ttf -= 1;
      if (s.ttf <= 0) {
        s.downLeft = Math.max(5, Math.round(this.expo(d.mttr, i)));
        s.ttf = this.expo(d.mtbf, i);
      }
      if (s.remaining <= 0) {
        s.done++;
        s.recent.push(s.curCt);
        if (s.recent.length > 20) s.recent.shift();
        s.carry = this.push(i) ? s.remaining : 0;
      }
      return 'busy';
    }

    classify(j) {
      const s = this.st[j];
      if (s.status === 'down') return 'stop';
      if (s.status === 'busy' && s.curCt > this.cfg.stations[j].ct * 1.06) return 'slow';
      return 'rate';
    }

    attribute() {
      const n = this.n;
      for (let i = 0; i < n; i++) {
        const s = this.st[i];
        let root = -1;
        if (s.status === 'starved') {
          let j = i - 1;
          while (j > 0 && this.st[j].status === 'starved') j--;
          root = j;
        } else if (s.status === 'blocked') {
          let j = i + 1;
          while (j < n - 1 && this.st[j].status === 'blocked') j++;
          root = j;
        } else if (s.status === 'down') {
          root = i;
        }
        if (root < 0) continue;
        const cause = this.classify(root);
        if (s.status !== 'down') this.matrix[root][i]++;
        if (i === this.constraint) {
          const key = root + '|' + cause;
          this.lossByKey[key] = (this.lossByKey[key] || 0) + 1;
          this.constraintIdle++;
        }
      }
    }

    step() {
      const t = this.t;
      for (let i = this.n - 1; i >= 0; i--) {
        const s = this.st[i];
        const forced = !!this.activeEvent(i, 'stop');
        let status;
        if (forced || s.downLeft > 0) {
          if (!forced) s.downLeft--;
          if (!s.inDown) { s.inDown = true; s.downStart = t; }
          status = 'down';
          s.carry = 0;
        } else {
          if (s.inDown) {
            const dur = t - s.downStart;
            s.stops.count++; s.stops.total += dur; if (dur < 60) s.stops.micro++;
            s.inDown = false;
          }
          status = this.work(i);
        }
        s.status = status;
        s.acc[status]++;
      }
      this.attribute();

      this.t++;
      if (this.t % 10 === 0) this.hist.push({ t: this.t, out: this.out, buf: this.buf.slice() });
      if (this.t % 30 === 0) {
        this.st.forEach((s, i) => { if (s.recent.length) this.ctHist[i].push({ t: this.t, v: mean(s.recent) }); });
      }
    }

    run(seconds) { for (let k = 0; k < seconds; k++) this.step(); return this; }
  }

  /* ---------- analytics ---------- */

  function linreg(pts) {
    const n = pts.length;
    if (n < 2) return 0;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    pts.forEach((p) => { sx += p.x; sy += p.y; sxy += p.x * p.y; sxx += p.x * p.x; });
    const den = n * sxx - sx * sx;
    return den === 0 ? 0 : (n * sxy - sx * sy) / den;
  }

  // Feature 3 engine: early-warning forecast from live sim history
  function forecast(sim) {
    const alerts = [];
    const n = sim.n;
    const names = sim.cfg.stations.map((s) => s.name);
    let bufRisk = 0, driftRisk = 0;

    if (sim.hist.length >= 12) {
      const win = sim.hist.slice(-18);
      for (let b = 0; b < n - 1; b++) {
        const slope = linreg(win.map((h) => ({ x: h.t, y: h.buf[b] })));
        const lvl = sim.buf[b], cap = sim.cfg.caps[b];
        if (slope < -0.004 && lvl > 0) {
          const eta = lvl / -slope;
          if (eta < 300) {
            bufRisk = Math.max(bufRisk, clamp(1 - eta / 300));
            alerts.push({
              kind: 'starve', sev: eta < 90 ? 'high' : 'med', eta,
              title: names[b + 1] + ' likely to starve',
              detail: 'Buffer after ' + names[b] + ' is draining ' + (-slope * 60).toFixed(1) + ' trays/min.',
            });
          }
        } else if (slope > 0.004 && lvl < cap) {
          const eta = (cap - lvl) / slope;
          if (eta < 300) {
            bufRisk = Math.max(bufRisk, clamp(1 - eta / 300));
            alerts.push({
              kind: 'block', sev: eta < 90 ? 'high' : 'med', eta,
              title: names[b] + ' likely to be blocked',
              detail: 'Buffer before ' + names[b + 1] + ' is filling ' + (slope * 60).toFixed(1) + ' trays/min.',
            });
          }
        }
      }
    }

    const eff = sim.st.map((s, i) => {
      const down = sim.t ? s.acc.down / sim.t : 0;
      const ct = mean(s.recent) || sim.cfg.stations[i].ct;
      return ct / (1 - Math.min(0.9, down));
    });
    let constraintNow = 0;
    eff.forEach((e, i) => { if (e > eff[constraintNow]) constraintNow = i; });

    for (let i = 0; i < n; i++) {
      const pts = sim.ctHist[i].slice(-20); // last 10 minutes of rolling mean cycle time
      if (pts.length < 14) continue;
      const slope = linreg(pts.map((p) => ({ x: p.t, y: p.v })));
      const nominal = sim.cfg.stations[i].ct;
      const relPerHour = (slope * 3600) / nominal;
      if (relPerHour > 0.15) {
        const down = sim.t ? sim.st[i].acc.down / sim.t : 0;
        const effSlope = slope / (1 - Math.min(0.9, down));
        const othersMax = Math.max.apply(null, eff.filter((_, j) => j !== i));
        const gap = othersMax - eff[i];
        const etaMin = gap <= 0 ? 0 : gap / effSlope / 60;
        const proj = eff.map((e, j) => (j === i ? e + effSlope * 1800 : e));
        const cap30 = 3600 / Math.max.apply(null, proj);
        const capNow = 3600 / Math.max.apply(null, eff);
        driftRisk = Math.max(driftRisk, clamp(1 - etaMin / 60));
        alerts.push({
          kind: 'drift', sev: etaMin < 15 ? 'high' : 'med', eta: etaMin * 60,
          title: names[i] + ' cycle time drifting +' + (relPerHour * 100).toFixed(0) + '%/h',
          detail: etaMin === 0
            ? 'Already the line constraint. Capacity est. ' + capNow.toFixed(0) + ' trays/h now, ' + cap30.toFixed(0) + ' in 30 min.'
            : 'Projected to become the line constraint in ~' + etaMin.toFixed(0) + ' min. Capacity est. ' + capNow.toFixed(0) + ' -> ' + cap30.toFixed(0) + ' trays/h in 30 min.',
        });
      }
    }

    alerts.sort((a, b) => a.eta - b.eta);
    const risk = Math.round(100 * Math.min(1, Math.max(bufRisk, driftRisk * 0.9)));
    return { alerts, risk, constraintNow, eff, capacityNow: 3600 / eff[constraintNow] };
  }

  function runHeadless(cfg, o) {
    const sim = new Sim(cfg, o.seed || 7);
    (o.events || []).forEach((e) => sim.cfg.events.push(e));
    sim.run(o.warmup || 0);
    const out0 = sim.out;
    sim.run(o.seconds);
    return { rate: ((sim.out - out0) / o.seconds) * 3600, out: sim.out - out0, sim };
  }

  // Feature 4 engine: ripple what-if. ev = { station:index, type:'stop'|'slow', factor, durationSec }
  function whatIf(cfg, ev) {
    const seeds = [31, 32, 33];
    const start = 600, seconds = 3600;
    const id = cfg.stations[ev.station].id;
    const event = { station: id, type: ev.type, factor: ev.factor || 1.4, start: start, end: start + ev.durationSec };
    const n = cfg.stations.length;
    let baseOut = 0, evOut = 0;
    const idleBase = new Array(n).fill(0), idleEv = new Array(n).fill(0);
    // ripple timing: seconds after the event until a station's cumulative output
    // lags the undisturbed twin run by >= 3 trays (null = absorbed by buffers)
    const lagAt = new Array(n).fill(null);
    seeds.forEach((sd, k) => {
      const b = new Sim(cfg, sd), e = new Sim(cfg, sd);
      e.cfg.events.push(event);
      for (let t = 0; t < seconds; t++) {
        b.step(); e.step();
        if (k === 0 && t >= start) {
          for (let i = 0; i < n; i++) {
            if (lagAt[i] === null && b.st[i].done - e.st[i].done >= 3) lagAt[i] = t - start;
          }
        }
      }
      baseOut += b.out; evOut += e.out;
      b.st.forEach((s, i) => { idleBase[i] += s.acc.starved + s.acc.blocked; });
      e.st.forEach((s, i) => { idleEv[i] += s.acc.starved + s.acc.blocked; });
    });
    const m = seeds.length;
    return {
      station: ev.station, type: ev.type, durationSec: ev.durationSec,
      lostTrays: (baseOut - evOut) / m,
      baseOut: baseOut / m, evOut: evOut / m,
      idleDeltaMin: idleEv.map((v, i) => (v - idleBase[i]) / m / 60),
      lagAt: lagAt,
    };
  }

  // Feature 5 engine: marginal-gain ranking of improvement levers
  function sensitivity(cfg, o) {
    o = o || {};
    const seeds = o.seeds || [21, 22, 23];
    const seconds = o.seconds || 7200, warmup = o.warmup || 300;
    const base = cloneCfg(cfg, { events: [], tOffset: o.tOffset || 0 });
    const avg = (c) => mean(seeds.map((s) => runHeadless(c, { seconds, warmup, seed: s }).rate));
    const b = avg(base);
    const levers = [];
    base.stations.forEach((d, i) => {
      levers.push({ station: i, label: d.name + ': halve stop duration (faster recovery)', apply: (c) => { c.stations[i].mttr *= 0.5; } });
      levers.push({ station: i, label: d.name + ': cycle time -5%', apply: (c) => { c.stations[i].ct *= 0.95; } });
    });
    for (let k = 0; k < base.caps.length; k++) {
      levers.push({ station: -1, label: 'Buffer ' + base.stations[k].name + ' -> ' + base.stations[k + 1].name + ': +3 capacity', apply: (c) => { c.caps[k] += 3; } });
    }
    if (base.drift && base.drift.ratePerHour > 0) {
      levers.push({ station: 0, label: 'Recalibrate dryer moisture sensor (remove drift)', apply: (c) => { c.drift.ratePerHour = 0; } });
    }
    const rows = levers.map((l) => {
      const c = cloneCfg(base);
      l.apply(c);
      const gain = avg(c) - b;
      return { label: l.label, station: l.station, gain: gain, pct: (gain / b) * 100 };
    });
    rows.sort((x, y) => y.gain - x.gain);
    return { baseRate: b, rows: rows };
  }

  const api = { Sim, makeConfig, cloneCfg, theoretical, forecast, runHeadless, whatIf, sensitivity, PRESETS, PARTS_PER_TRAY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlasticSim = api;
})(typeof window !== 'undefined' ? window : globalThis);
