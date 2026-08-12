// test_kernels.mjs — aggregation, statistics and the unit rules.
//
// Plain node, assert-based, no test framework. Exits non-zero on any failure.
//
// The kernels are small; what they have to get right is not:
//
//   * A series is one stored plane. There is no aggregation across
//     interfaces, so the interesting cases are the REFUSALS — a path this
//     case never monitored, and a path that was monitored but not retained
//     at load, are different problems and must not read the same.
//   * NaN is "absent" and must never reach a statistic. It poisons Welford,
//     defeats every min/max comparison, and sorts to one end of a duration
//     curve as a cliff of apparent extremes (footgun 21).
//   * f32 is storage, f64 is arithmetic (footgun 11).
//   * A total exists only for units that may be summed over time. MW may
//     not, and the difference is data/quantity-rules.json's business, not a
//     guess at the call site.
//
// Run:  node test_kernels.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const { applyMask, buildSeries, createScratch, hasData, isAllZero, quantiles, sortAsc, stats } =
  await import('./src/kernels.ts');
const { HOURS_PER_YEAR } = await import('./src/calendar.ts');
const { interfaceGroups, prefixOf, scaleOf, scalesOf, temporalOf, totalIsMeaningful, unitOf } =
  await import('./src/rules.ts');

const HOURS = HOURS_PER_YEAR;
let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

/** A CaseData with `interfaces` planes, filled by `fill(interfaceIndex, hour)`.
 * `absent` names interfaces whose plane stays NaN with presence 0 — the shape
 * a file that does not monitor a path produces. */
function makeCase({
  name = 'CaseA',
  interfaces,
  fill = (i, h) => i * 1000 + h,
  absent = [],
  sourceColumns = interfaces,
  quantity = 'Power Flow (MW)',
  unit = 'MW',
  year = 2035,
} = {}) {
  const cube = new Float32Array(interfaces.length * HOURS).fill(NaN);
  const presence = new Uint8Array(interfaces.length);
  interfaces.forEach((iface, index) => {
    if (absent.includes(iface)) return;
    presence[index] = 1;
    for (let hour = 0; hour < HOURS; hour++) cube[index * HOURS + hour] = fill(index, hour);
  });
  return {
    name,
    cube,
    interfaces,
    presence,
    tou: new Uint8Array(HOURS),
    sourceColumns,
    year,
    quantity,
    unit,
  };
}

// ---------------------------------------------------------------- buildSeries

{
  const data = makeCase({ interfaces: ['P01', 'P02', 'P03'], absent: ['P03'] });
  const out = createScratch();

  const built = buildSeries(data, 'P02', out);
  assert.ok(built.values, 'a monitored path builds');
  assert.equal(built.values[0], 1000, 'the stored plane IS the series');
  assert.equal(built.values[HOURS - 1], 1000 + HOURS - 1);
  assert.equal(built.values, out, 'the caller-owned buffer is written, not a fresh one');
  ok('a retained interface builds straight out of its cube plane');

  assert.equal(hasData(data, 2), false, 'presence says P03 is absent');
  const missingPlane = buildSeries(data, 'P03', out);
  assert.equal(missingPlane.values, null, 'an absent plane refuses');
  assert.match(missingPlane.refusal, /no data/);

  // Monitored but not retained, versus never monitored: different problems,
  // different fixes, so they must not share a message.
  const narrow = makeCase({
    interfaces: ['P01'],
    sourceColumns: ['P01', 'P02'],
  });
  const notRetained = buildSeries(narrow, 'P02', out);
  assert.equal(notRetained.values, null);
  assert.match(notRetained.refusal, /was not retained at load/);
  const neverSeen = buildSeries(narrow, 'P99', out);
  assert.match(neverSeen.refusal, /does not monitor/);
  ok('"not retained" and "not monitored" refuse with different messages');
}

// ---------------------------------------------------------------- applyMask

{
  const series = createScratch();
  const mask = new Uint8Array(HOURS);
  for (let hour = 0; hour < HOURS; hour++) {
    series[hour] = hour % 5 === 0 ? NaN : hour;
    mask[hour] = hour % 2 === 0 ? 1 : 0;
  }
  const gathered = createScratch();
  const n = applyMask(series, mask, gathered);

  let expected = 0;
  for (let hour = 0; hour < HOURS; hour += 2) if (hour % 5 !== 0) expected++;
  assert.equal(n, expected, 'kept hours minus the absent ones');
  for (let i = 0; i < n; i++) {
    assert.ok(!Number.isNaN(gathered[i]), 'NaN never reaches the gathered buffer');
    assert.equal(gathered[i] % 2, 0, 'only masked-in hours are gathered');
  }
  ok(`applyMask drops filtered hours and NaN alike (${n.toLocaleString()} kept)`);
}

// ---------------------------------------------------------------- stats

{
  const values = new Float32Array([2, 4, 4, 4, 5, 5, 7, 9]);
  const summary = stats(values, values.length);
  assert.equal(summary.n, 8);
  assert.equal(summary.mean, 5);
  assert.equal(summary.min, 2);
  assert.equal(summary.max, 9);
  assert.equal(summary.sum, 40);
  // Sample (n-1) standard deviation of that textbook set is sqrt(32/7).
  assert.ok(Math.abs(summary.sd - Math.sqrt(32 / 7)) < 1e-12, `sd was ${summary.sd}`);
  ok('stats: mean, min, max, total and the (n-1) standard deviation');

  // The shape naive f32 accumulation gets wrong: a large mean and a small
  // spread. Welford in f64 must land on the f64 reference.
  const n = 8760;
  const wide = new Float32Array(n);
  for (let i = 0; i < n; i++) wide[i] = 1e6 + (i % 7) - 3;
  const measured = stats(wide, n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += wide[i] / n;
  let m2 = 0;
  for (let i = 0; i < n; i++) m2 += (wide[i] - mean) ** 2;
  const referenceSd = Math.sqrt(m2 / (n - 1));
  assert.ok(
    Math.abs(measured.sd - referenceSd) / referenceSd < 1e-9,
    `sd ${measured.sd} vs reference ${referenceSd}`,
  );
  ok('stats: f64 Welford matches an f64 reference on a large-mean, small-spread series');

  // The compensated total, on the shape that loses digits when added naively.
  const mixed = new Float32Array([1e8, 1, -1e8, 1]);
  assert.equal(stats(mixed, 4).sum, 2, 'the compensated total keeps the small terms');
  ok('stats: the total is compensated, so small terms survive a large one');

  const empty = stats(new Float32Array(0), 0);
  assert.equal(empty.n, 0);
  assert.ok(Number.isNaN(empty.mean) && Number.isNaN(empty.sum));
  const single = stats(new Float32Array([3]), 1);
  assert.ok(Number.isNaN(single.sd), 'one point has no sample standard deviation');
  ok('stats: an empty selection is NaN, not 0, and n=1 has no sd');
}

// ---------------------------------------------------------------- quantiles

{
  const values = new Float32Array(101);
  for (let i = 0; i <= 100; i++) values[i] = i;
  const q = quantiles(values, 101);
  assert.equal(q.n, 101);
  assert.equal(q.min, 0);
  assert.equal(q.max, 100);
  assert.equal(q.median, 50);
  assert.equal(q.p25, 25);
  assert.equal(q.p75, 75);
  assert.equal(q.outliers, 0, 'a uniform spread has no Tukey outliers');
  assert.equal(q.degenerate, false);
  ok('quantiles: min/p25/median/p75/max on a known uniform spread');

  // One extreme value: the whisker stops at the last point inside the fence
  // and the extreme is counted as an outlier rather than becoming the whisker.
  const withOutlier = new Float32Array([...values.slice(0, 101), 10000]);
  const q2 = quantiles(withOutlier, 102);
  assert.equal(q2.max, 10000);
  assert.ok(q2.upperWhisker < 200, `whisker was ${q2.upperWhisker}`);
  assert.equal(q2.outliers, 1);
  ok('quantiles: Tukey fences separate the whisker from the extreme');

  // A path that never binds: zero all year. Correct, useless, and it looks
  // broken, which is why the panes are told about it (footgun 19).
  const zeros = new Float32Array(500);
  const q3 = quantiles(zeros, 500);
  assert.equal(q3.degenerate, true);
  assert.equal(isAllZero(zeros, 500), true);
  assert.equal(isAllZero(new Float32Array([0, 0, 1]), 3), false);
  assert.equal(isAllZero(zeros, 0), false, 'an empty selection is not "all zero"');
  ok('quantiles: an all-zero column is flagged degenerate, and isAllZero agrees');

  const none = quantiles(new Float32Array(4), 0);
  assert.ok(Number.isNaN(none.median) && none.n === 0);
  ok('quantiles: nothing kept reads as NaN, never as 0');

  // Negative flows are ordinary: a path runs both ways.
  const signed = new Float32Array([-500, -100, 0, 100, 500]);
  const q4 = quantiles(signed, 5);
  assert.equal(q4.min, -500);
  assert.equal(q4.median, 0);
  assert.deepEqual(Array.from(sortAsc(new Float32Array([3, -1, 2]), 3)), [-1, 2, 3]);
  ok('quantiles and sortAsc order negative values correctly');
}

// ---------------------------------------------------------------- unit rules

{
  assert.equal(unitOf('Power Flow (MW)'), 'MW');
  assert.equal(unitOf('Congestion Cost ($)'), '$');
  assert.equal(unitOf('Shadow Price ($/MWh)'), '$/MWh');
  assert.equal(unitOf('Congestion Cost (Total) ($)'), '$', 'the last parenthesis is the unit');
  assert.equal(unitOf('Interface Utilisation'), '', 'no parentheses, no guessed unit');
  ok('unitOf reads the unit out of the title-line quantity');

  assert.equal(temporalOf('MW'), 'MEAN');
  assert.equal(temporalOf('$'), 'SUM');
  assert.equal(temporalOf('MWh'), 'SUM');
  assert.equal(temporalOf('$/MWh'), 'MEAN');
  assert.equal(temporalOf('bananas'), 'MEAN', 'an unknown unit gets a mean, never a total');
  assert.equal(totalIsMeaningful('MW'), false, 'MW is a rate: no period total');
  assert.equal(totalIsMeaningful('$'), true);
  ok('a period total is offered only where summing over hours is meaningful');

  assert.equal(scaleOf('MW'), 'MWh', 'MW and MWh are the same number for one hour');
  assert.equal(scaleOf('$'), '$');
  assert.deepEqual(scalesOf([{ unit: 'MW' }, { unit: 'MWh' }, { unit: '$' }]), [
    { scale: 'MWh', label: 'MW · MWh' },
    { scale: '$', label: '$' },
  ]);
  assert.deepEqual(scalesOf([{ unit: '' }]), [{ scale: '', label: '(no unit)' }]);
  ok('scalesOf merges MW with MWh and keeps everything else on its own axis');
}

// ---------------------------------------------------------------- grouping

{
  assert.equal(prefixOf('P84 Harry Allen 500 kV N-S'), 'P84');
  assert.equal(prefixOf('W36_SW_AZPS__CA_CISO_1'), 'W36');
  assert.equal(prefixOf('Pth 03 Delaney'), 'Pth 03', 'a numbered word keeps its number');
  assert.equal(prefixOf('TransbayCable'), 'Tran', 'a single word falls back to four characters');

  const names = ['B path', 'A path', 'C path'];
  const coverage = new Map([
    ['A path', ['one', 'two']],
    ['B path', ['one']],
    ['C path', ['one', 'two']],
  ]);
  assert.deepEqual(interfaceGroups(names, coverage, 2), [
    { title: 'In every file', names: ['A path', 'C path'] },
    { title: 'In some files only', names: ['B path'] },
  ]);
  assert.deepEqual(interfaceGroups(names, coverage, 1), [
    { title: 'Interfaces', names: ['A path', 'B path', 'C path'] },
  ]);
  assert.deepEqual(interfaceGroups([], coverage, 1), [], 'nothing listed is no groups at all');
  ok('interfaces are grouped by file coverage, and sorted inside each group');
}

console.log(`\n${checks} checks passed.`);
