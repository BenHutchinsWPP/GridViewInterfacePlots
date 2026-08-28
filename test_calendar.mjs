// test_calendar.mjs — the 8,760-hour calendar, the keep-mask, the status line.
//
// Plain node, assert-based, no test framework. Exits non-zero on any failure.
//
// The calendar is pure index arithmetic and never touches a Date object
// (footgun 3): one `new Date(str)` shifts rows by a day in half the world's
// timezones. So the day-of-week has to be checked against dates whose weekday
// is known independently, not against a Date the same bug would produce.
//
// The mask is where a filter becomes a selection, and TOU is the one
// dimension in it that is FILE DATA rather than a formula (footgun 17).
//
// Run:  node test_calendar.mjs

import assert from 'node:assert/strict';
import './test_loader.mjs';

const {
  buildCalendar,
  buildMask,
  DAY_NAMES,
  getDayOfMonth,
  getDayOfWeek,
  getHourOfDay,
  getMonth,
  getSeason,
  HOURS_PER_YEAR,
  MONTH_NAMES,
  SEASON_NAMES,
  TOU_LABELS,
} = await import('./src/calendar.ts');
const { statusSentence } = await import('./src/ui/shell.ts');

const HOURS = HOURS_PER_YEAR;
let checks = 0;
function ok(label) {
  checks++;
  console.log(`ok - ${label}`);
}

const NO_FILTERS = {
  months: null,
  daysOfMonth: null,
  hoursOfDay: null,
  daysOfWeek: null,
  seasons: null,
  tou: null,
};

// ---------------------------------------------------------------- shape

{
  const calendar = buildCalendar(2035);
  assert.equal(calendar.length, HOURS, 'a case is exactly 8,760 hours (D4)');
  assert.equal(buildCalendar(2035), calendar, 'calendars are memoized per year');
  assert.notEqual(buildCalendar(2036), calendar, 'a different year is a different calendar');

  // Every hour of the year, walked independently of the packed entry.
  const LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let hour = 0;
  for (let month = 1; month <= 12; month++) {
    for (let day = 1; day <= LENGTHS[month - 1]; day++) {
      for (let he = 1; he <= 24; he++) {
        const entry = calendar[hour++];
        assert.equal(getMonth(entry), month);
        assert.equal(getDayOfMonth(entry), day);
        assert.equal(getHourOfDay(entry), he);
      }
    }
  }
  assert.equal(hour, HOURS, 'the walk covers the year exactly');
  ok('every hour decodes to its own month, day and hour-ending — 8,760 of them');

  // A leap year uses the same 8,760 hours: Feb 29 is dropped at ingest, so
  // Mar 1 sits at the same index in 2035 and 2036 and the cases overlay.
  const leap = buildCalendar(2036);
  const mar1 = (31 + 28) * 24;
  assert.equal(getMonth(leap[mar1]), 3);
  assert.equal(getDayOfMonth(leap[mar1]), 1);
  ok('a leap year is the same 8,760 hours — Feb 29 never enters the calendar');
}

// ---------------------------------------------------------------- weekday

{
  // Weekdays taken from the proleptic Gregorian calendar, not from a Date.
  // 1 Jan 2035 is a Monday; 4 July 2035 a Wednesday; 25 Dec 2035 a Tuesday.
  const calendar = buildCalendar(2035);
  const at = (month, day) => {
    const before = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    return (before[month - 1] + day - 1) * 24;
  };
  assert.equal(DAY_NAMES[getDayOfWeek(calendar[at(1, 1)])], 'Mon');
  assert.equal(DAY_NAMES[getDayOfWeek(calendar[at(7, 4)])], 'Wed');
  assert.equal(DAY_NAMES[getDayOfWeek(calendar[at(12, 25)])], 'Tue');
  // 2044, one of the years these studies run in: 1 Jan 2044 is a Friday.
  assert.equal(DAY_NAMES[getDayOfWeek(buildCalendar(2044)[0])], 'Fri');
  // Consecutive days advance by exactly one weekday, all year.
  for (let day = 1; day < 365; day++) {
    const previous = getDayOfWeek(calendar[(day - 1) * 24]);
    assert.equal(getDayOfWeek(calendar[day * 24]), (previous + 1) % 7, `day ${day}`);
  }
  ok('day-of-week is Sakamoto arithmetic, checked against known dates and continuity');

  assert.equal(SEASON_NAMES[getSeason(calendar[at(1, 15)])], 'Winter');
  assert.equal(SEASON_NAMES[getSeason(calendar[at(4, 15)])], 'Spring');
  assert.equal(SEASON_NAMES[getSeason(calendar[at(7, 15)])], 'Summer');
  assert.equal(SEASON_NAMES[getSeason(calendar[at(10, 15)])], 'Fall');
  assert.equal(SEASON_NAMES[getSeason(calendar[at(12, 15)])], 'Winter', 'December is Winter');
  ok('seasons run Dec-Feb, Mar-May, Jun-Aug, Sep-Nov');
}

// ---------------------------------------------------------------- the mask

{
  const calendar = buildCalendar(2035);
  const tou = new Uint8Array(HOURS);
  // OnPeak on hour-ending 6..22, every day: a rule, so that a mask that
  // recomputed TOU instead of reading it would still pass — which is why the
  // second bitmap below is deliberately arbitrary.
  for (let hour = 0; hour < HOURS; hour++) {
    const he = getHourOfDay(calendar[hour]);
    tou[hour] = he >= 6 && he <= 22 ? 1 : 0;
  }

  const count = (mask) => mask.reduce((total, keep) => total + keep, 0);

  assert.equal(count(buildMask(NO_FILTERS, calendar, tou)), HOURS, 'no filter keeps everything');

  const january = buildMask({ ...NO_FILTERS, months: new Set([1]) }, calendar, tou);
  assert.equal(count(january), 31 * 24);

  const firsts = buildMask({ ...NO_FILTERS, daysOfMonth: new Set([1]) }, calendar, tou);
  assert.equal(count(firsts), 12 * 24, 'the 1st of every month');

  const thirtyFirsts = buildMask({ ...NO_FILTERS, daysOfMonth: new Set([31]) }, calendar, tou);
  // Only the seven 31-day months have one, so a high day is not an error --
  // it just keeps fewer hours.
  assert.equal(count(thirtyFirsts), 7 * 24, 'only the 31-day months have a 31st');

  const he17 = buildMask({ ...NO_FILTERS, hoursOfDay: new Set([17]) }, calendar, tou);
  assert.equal(count(he17), 365, 'one hour-ending a day, all year');

  const weekend = buildMask({ ...NO_FILTERS, daysOfWeek: new Set([5, 6]) }, calendar, tou);
  // 2035 starts on a Monday and runs 365 days = 52 weeks + one Monday, so
  // every other weekday, Saturday and Sunday included, occurs 52 times.
  assert.equal(count(weekend), 104 * 24, '52 Saturdays and 52 Sundays');

  const summer = buildMask({ ...NO_FILTERS, seasons: new Set(['Summer']) }, calendar, tou);
  assert.equal(count(summer), (30 + 31 + 31) * 24);

  const onPeak = buildMask({ ...NO_FILTERS, tou: new Set(['OnPeak']) }, calendar, tou);
  assert.equal(count(onPeak), 365 * 17);
  ok('each filter alone keeps exactly the hours it names');

  // Combined filters intersect.
  const narrow = buildMask(
    {
      months: new Set([7]),
      daysOfMonth: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      hoursOfDay: new Set([17, 18]),
      daysOfWeek: new Set([0, 1, 2, 3, 4]),
      seasons: new Set(['Summer']),
      tou: new Set(['OnPeak']),
    },
    calendar,
    tou,
  );
  let expected = 0;
  for (let hour = 0; hour < HOURS; hour++) {
    const entry = calendar[hour];
    const he = getHourOfDay(entry);
    if (
      getMonth(entry) === 7 &&
      getDayOfMonth(entry) <= 10 &&
      (he === 17 || he === 18) &&
      getDayOfWeek(entry) <= 4 &&
      SEASON_NAMES[getSeason(entry)] === 'Summer' &&
      TOU_LABELS[tou[hour]] === 'OnPeak'
    ) {
      expected++;
    }
  }
  assert.equal(count(narrow), expected);
  assert.ok(expected > 0, 'the combined filter must keep something to be a test');
  ok(`combined filters intersect (${expected} hours kept by all six)`);

  // TOU is read, never recomputed (footgun 17). This bitmap follows no rule a
  // calendar could produce, and the mask must follow it exactly.
  const arbitrary = new Uint8Array(HOURS);
  for (let hour = 0; hour < HOURS; hour++) arbitrary[hour] = (hour * 7919) % 3 === 0 ? 1 : 0;
  const readTou = buildMask({ ...NO_FILTERS, tou: new Set(['OnPeak']) }, calendar, arbitrary);
  for (let hour = 0; hour < HOURS; hour++) {
    assert.equal(readTou[hour], arbitrary[hour], `TOU at hour ${hour} must come from the file`);
  }
  ok('the TOU filter follows the file\'s own bitmap, whatever shape it has');

  // The output buffer is reused across interactions: it must be fully
  // rewritten, never OR-ed into.
  const buffer = new Uint8Array(HOURS).fill(1);
  buildMask({ ...NO_FILTERS, months: new Set([2]) }, calendar, tou, buffer);
  assert.equal(count(buffer), 28 * 24, 'a reused buffer is overwritten, not merged');
  ok('buildMask overwrites the caller-owned buffer completely');
}

// ---------------------------------------------------------------- status line

{
  const query = {
    cases: ['01_PF', '02_PF'],
    interfaces: ['P84 Alpha N-S'],
    filters: { ...NO_FILTERS },
    boxDim: 'case',
  };
  const sentence = statusSentence(query, 8760);
  assert.match(sentence, /8,760 of 8,760 h/);
  assert.match(sentence, /all months/);
  assert.match(sentence, /P84 Alpha N-S/);
  assert.match(sentence, /2 cases/);

  const filtered = statusSentence(
    {
      ...query,
      filters: {
        ...NO_FILTERS,
        months: new Set([1, 2, 3, 7]),
        hoursOfDay: new Set([17, 18]),
        tou: new Set(['OnPeak']),
      },
    },
    1234,
  );
  assert.match(filtered, /Jan–Mar, Jul/, 'runs collapse, gaps do not');
  assert.match(filtered, /HE 17–18/);
  assert.match(filtered, /OnPeak/);
  ok('the status bar states its own filters, with runs collapsed');

  // Ten selected paths would push the filters off the end of the bar.
  const many = statusSentence(
    { ...query, interfaces: MONTH_NAMES.map((m) => `${m} path`) },
    8760,
  );
  assert.match(many, /12 interfaces/);
  assert.ok(!many.includes('Jan path'), 'a long interface list is summarised, not listed');
  ok('a long interface selection is counted rather than spelled out');
}

console.log(`\n${checks} checks passed.`);
