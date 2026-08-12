// src/rules.ts
//
// Units, aggregation rules and the interface-name grouping the picker and the
// rail share.
//
// The rule that matters here is small and load-bearing: an interface export is
// one QUANTITY for every interface it monitors, so the unit and the temporal
// rule come from the file's title line and not from a column name (D13). A
// congestion cost may be totalled over a selection; a power flow in MW may
// not, because MW summed over a filtered set of hours is not a quantity at
// all. Never re-derive this -- branch on `temporal` from
// data/quantity-rules.json.

import rulesData from '../data/quantity-rules.json' with { type: 'json' };
import type { TemporalRule, UnitRule } from './types';

const byUnit = new Map<string, UnitRule>();
for (const rule of rulesData.units as UnitRule[]) byUnit.set(rule.unit, rule);

/** Quantities seen in a real export, for the "unrecognised quantity" note. */
export const KNOWN_QUANTITIES: readonly string[] = rulesData.quantities;

/**
 * The unit inside a quantity's parentheses: `Power Flow (MW)` -> `MW`,
 * `Congestion Cost ($)` -> `$`. The LAST parenthesised group wins, so a
 * quantity that qualifies itself -- `Congestion Cost (Total) ($)` -- still
 * yields its unit. Returns '' when there is nothing to read, which is a
 * stated no-unit case and never a guessed one.
 */
export function unitOf(quantity: string): string {
  const groups = quantity.match(/\(([^()]*)\)/g);
  if (!groups || groups.length === 0) return '';
  return groups[groups.length - 1].slice(1, -1).trim();
}

/** The rule for a unit, or undefined when this build has no rule for it. */
export function ruleForUnit(unit: string): UnitRule | undefined {
  return byUnit.get(unit.trim());
}

/**
 * How hours combine for a unit. Anything unrecognised is MEAN: a mean is
 * always a defined number, whereas a total of an unknown unit is exactly the
 * plausible-looking wrong answer this project keeps refusing to produce.
 */
export function temporalOf(unit: string): TemporalRule {
  return ruleForUnit(unit)?.temporal ?? 'MEAN';
}

/** True when a period total over the filtered hours is a meaningful number. */
export function totalIsMeaningful(unit: string): boolean {
  return temporalOf(unit) === 'SUM';
}

/**
 * The y scale a unit is drawn on. Two units share a scale only when they are
 * the same NUMBER, which MW and MWh are here: every value in the cube is one
 * hour, and 1 MW held for an hour is 1 MWh.
 *
 * This is a property of the HOUR, not of the units, and it stops at the chart.
 * A period total of MW is still not MWh -- see `temporalOf` -- so nothing here
 * touches the stats table, which keeps treating MW as a rate.
 */
export function scaleOf(unit: string): string {
  return unit === 'MW' ? 'MWh' : unit;
}

/**
 * Distinct y scales among the drawn lines, in first-seen order, each labelled
 * with every unit sharing it -- so a merged axis reads "MWh · MW" rather than
 * silently renaming one of them. A line with no unit is labelled `(no unit)`
 * and gets an axis of its own rather than borrowing someone else's.
 */
export function scalesOf(series: { unit: string }[]): { scale: string; label: string }[] {
  const byScale = new Map<string, string[]>();
  for (const { unit } of series) {
    const scale = scaleOf(unit);
    const seen = byScale.get(scale) ?? [];
    if (!seen.includes(unit)) seen.push(unit);
    byScale.set(scale, seen);
  }
  return [...byScale].map(([scale, units]) => ({
    scale,
    label: units.map((unit) => unit || '(no unit)').join(' · '),
  }));
}

/**
 * The leading token of an interface name, used to file 167 paths into
 * something an eye can scan: `P84 Harry Allen…` -> `P84`, `W36_SW_AZPS__…` ->
 * `W36`, `Pth 03 Delaney…` -> `Pth 03`.
 *
 * Purely cosmetic. Nothing downstream branches on it, because an interface
 * naming convention is the analyst's, not GridView's -- which is also why the
 * grouping below is by FILE COVERAGE and this is only the sort key inside a
 * group.
 */
export function prefixOf(name: string): string {
  const trimmed = name.trim();
  const spaced = /^([A-Za-z]+ ?\d*)[\s_]/.exec(trimmed);
  return spaced ? spaced[1] : trimmed.slice(0, 4);
}

export interface InterfaceGroup {
  title: string;
  names: string[];
}

/**
 * Interfaces bucketed for display. With several files dropped at once the
 * useful split is COVERAGE -- which paths every run monitors, and which only
 * some do (D14) -- because that is the question a mixed drop actually raises
 * and the one the analyst cannot answer by reading the names.
 *
 * `coverage` maps interface -> the case names carrying it. With one file (or
 * none) there is nothing to split on and everything lands in one group.
 */
export function interfaceGroups(
  names: string[],
  coverage: Map<string, string[]> | null,
  caseCount: number,
): InterfaceGroup[] {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (!coverage || caseCount < 2) {
    return sorted.length > 0 ? [{ title: 'Interfaces', names: sorted }] : [];
  }

  const everywhere: string[] = [];
  const partial: string[] = [];
  for (const name of sorted) {
    ((coverage.get(name)?.length ?? 0) >= caseCount ? everywhere : partial).push(name);
  }
  return [
    { title: 'In every file', names: everywhere },
    { title: 'In some files only', names: partial },
  ].filter((group) => group.names.length > 0);
}
