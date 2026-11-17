// Run with: node tests/sim.test.js   (no dependencies)
const assert = require('assert');
const P = require('../sim.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok   - ' + name); }
  catch (e) { console.error('FAIL - ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

test('simulation is deterministic for a given seed', () => {
  const a = new P.Sim(P.makeConfig('drift'), 5).run(3000);
  const b = new P.Sim(P.makeConfig('drift'), 5).run(3000);
  assert.strictEqual(a.out, b.out);
  assert.deepStrictEqual(a.buf, b.buf);
});

test('buffers always stay within capacity and output never exceeds the ideal', () => {
  const s = new P.Sim(P.makeConfig('cascade'), 3);
  for (let t = 0; t < 4000; t++) {
    s.step();
    s.buf.forEach((v, i) => assert.ok(v >= 0 && v <= s.cfg.caps[i], 'buffer ' + i + ' out of range at t=' + t));
  }
  assert.ok(s.out <= (4000 / 4.0) * 1.05);
});

test('every second is accounted to exactly one status per station', () => {
  const s = new P.Sim(P.makeConfig('drift'), 9).run(2500);
  s.st.forEach((st) => {
    const sum = st.acc.busy + st.acc.starved + st.acc.blocked + st.acc.down;
    assert.strictEqual(sum, s.t);
  });
});

test('healthy line runs near capacity; drift scenario loses output', () => {
  const healthy = new P.Sim(P.makeConfig('healthy'), 7).run(7200);
  const drift = new P.Sim(P.makeConfig('drift'), 7).run(7200);
  assert.ok(healthy.out > drift.out * 1.05, 'healthy ' + healthy.out + ' vs drift ' + drift.out);
});

test('healthy line raises no drift alarms (no false positives)', () => {
  const s = new P.Sim(P.makeConfig('healthy'), 7);
  for (let m = 0; m < 120; m++) {
    s.run(60);
    assert.ok(!P.forecast(s).alerts.some((a) => a.kind === 'drift'), 'false drift alarm at minute ' + m);
  }
});

test('drift scenario is flagged early, naming the dryer, well before it becomes the constraint', () => {
  const s = new P.Sim(P.makeConfig('drift'), 7);
  let flagged = null;
  for (let m = 1; m <= 40 && flagged === null; m++) {
    s.run(60);
    const a = P.forecast(s).alerts.find((x) => x.kind === 'drift' && /Dryer/.test(x.title));
    if (a) flagged = { minute: m, etaSec: a.eta };
  }
  assert.ok(flagged, 'dryer drift never flagged');
  assert.ok(flagged.minute <= 20, 'flagged too late: minute ' + flagged.minute);
  assert.ok(flagged.etaSec > 20 * 60, 'should predict the takeover well in the future');
});

test('what-if: stopping packaging loses output and ripples upstream', () => {
  const r = P.whatIf(P.makeConfig('healthy'), { station: 4, type: 'stop', durationSec: 180 });
  assert.ok(r.lostTrays > 30, 'lost ' + r.lostTrays);
  assert.ok(r.lagAt[4] !== null && r.lagAt[4] < 60, 'origin lags immediately');
  assert.ok(r.lagAt[1] !== null && r.lagAt[1] > r.lagAt[4], 'molding is hit later than packaging');
});

test('what-if: a longer stop loses more output than a shorter one', () => {
  const a = P.whatIf(P.makeConfig('healthy'), { station: 1, type: 'stop', durationSec: 60 });
  const b = P.whatIf(P.makeConfig('healthy'), { station: 1, type: 'stop', durationSec: 300 });
  assert.ok(b.lostTrays > a.lostTrays);
});

test('sensitivity ranks levers in descending order and puts drift recalibration on top in the drift scenario', () => {
  const r = P.sensitivity(P.makeConfig('drift'), { tOffset: 3600 });
  for (let i = 1; i < r.rows.length; i++) assert.ok(r.rows[i - 1].gain >= r.rows[i].gain);
  assert.ok(/Recalibrate/.test(r.rows[0].label), 'top lever was: ' + r.rows[0].label);
});

console.log('\n' + passed + ' tests passed');
