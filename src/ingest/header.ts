// src/ingest/header.ts
//
// Preamble, header parse, canonical names, column plan.
//
// The one rule this file exists to enforce: **columns are mapped by trimmed
// canonical header name, never by position** (footgun 18). Two exports of the
// same study routinely list different interfaces in different orders -- a new
// path is added, a retired one disappears, and every column after it shifts.
// A positional parser would then plot one path's flows under another path's
// name, with nothing thrown and a chart that renders. That is the worst
// failure available in this project, so the plan built here is the only thing
// standing between the cube and plausible wrong numbers.
//
// This module is deliberately free of DOM, Worker and Vite specifics so
// test_ingest.mjs can import it straight into node.

/**
 * Constants mirrored from parser/block.c. They are compiled into the wasm
 * module; `slab_metrics()` and `slab_rows()` are exported so block.ts can
 * prove the mirror still matches (an unchecked mirror is how a rebuilt
 * parser silently truncates a wide export).
 */
export const SLAB_METRICS = 512; // block.c `NUM` -- interface columns per export
export const KEY_COLS = 3; // block.c: Date, Hour, TOU; source col >= 3 is an interface

/**
 * Lines above the header. A GridView interface export opens with a title, a
 * blank line, a date-range note and another blank line; the column header is
 * line 5. The area exports this tool grew out of had none of that, and the
 * count is fixed by the exporter, not by the study -- so it is a constant
 * here and a hard requirement at ingest, never a "skip until something looks
 * like a header" guess.
 */
export const PREAMBLE_LINES = 4;

export interface HeaderInfo {
  /** Fields exactly as they appear in the file (CR stripped), for display. */
  raw: string[];
  /** `raw` trimmed -- the key everything else matches on. */
  canonical: string[];
  dateCol: number;
  hourCol: number;
  touCol: number;
  /** Canonical names of the interface columns, in source order. */
  interfaceNames: string[];
}

/** What the title line above the header states about the whole file. */
export interface TitleInfo {
  /** The quoted quantity, e.g. `Power Flow (MW)` -- '' when unreadable. */
  quantity: string;
  /** The year in the title, or null. The first data row is authoritative;
   * this is the cross-check. */
  year: number | null;
}

export interface ColumnPlan {
  /** The cube's interface axis: the retained list, in cube-index order. */
  interfaces: string[];
  /**
   * Indexed by SOURCE column index; value is the cube interface index this
   * column feeds, or -1 to skip. Key columns are always -1.
   */
  plan: Int32Array;
  /**
   * The same mapping indexed by block.c slab plane (`slab plane m` ==
   * `source column m + KEY_COLS`), length SLAB_METRICS. This is what the
   * worker and the blit both index by, because block.c writes columns
   * positionally into the slab and the plan is applied on the way out.
   */
  slabPlan: Int32Array;
  /** Slab planes with a destination, ascending -- the transfer order. */
  activePlanes: Int32Array;
  /** Per-interface presence: 1 = this file's header carries it, 0 = absent. */
  presence: Uint8Array;
}

/** Strip a trailing CR (footgun 16: exports are CRLF, header included). */
function stripCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Read the quantity and year out of the export's first line:
 *
 *   Interface Hourly 'Power Flow (MW)' Data for Year 2034
 *
 * The quantity is what the whole file measures -- every column is that same
 * quantity for a different interface -- so it is the file's unit and the file's
 * aggregation rule (src/rules.ts). Unreadable is reported, never guessed: a
 * file whose quantity cannot be read still plots, it just cannot claim a unit.
 */
export function parseTitleLine(line: string): TitleInfo {
  const text = stripCR(line);
  const quoted = /'([^']+)'/.exec(text);
  const year = /year\s+(\d{4})/i.exec(text);
  return {
    quantity: quoted ? quoted[1].trim() : '',
    year: year ? Number(year[1]) : null,
  };
}

/**
 * Parse a header line into raw + canonical names and locate the three key
 * columns **by name**. The real export's header carries stray spaces
 * (` Hour`, ` TOU`) and interface names with spaces, plus signs and
 * punctuation inside them, so the raw string is kept for display and the
 * trimmed string is the key.
 */
export function parseHeaderLine(line: string): HeaderInfo {
  const raw = stripCR(line).split(',');
  const canonical = raw.map((s) => s.trim());

  const at = (name: string): number => {
    const i = canonical.indexOf(name);
    if (i < 0) {
      throw new Error(
        `CSV header is missing the required key column "${name}". Found: ${canonical
          .slice(0, KEY_COLS)
          .map((c) => JSON.stringify(c))
          .join(', ')}`,
      );
    }
    return i;
  };

  const dateCol = at('Date');
  const hourCol = at('Hour');
  const touCol = at('TOU');

  // parser/block.c hardcodes col 0 = Date, col 1 = Hour, col 2 = TOU and
  // treats every col >= 3 as an interface (col - 3). We refuse rather than
  // parse a layout the wasm module would silently misread -- the whole point
  // of this file is that silent misreads are the failure mode here.
  if (dateCol !== 0 || hourCol !== 1 || touCol !== 2) {
    throw new Error(
      `Unsupported column layout: parser/block.c requires the key columns in the ` +
        `canonical order Date,Hour,TOU at indices 0-2, but this export has ` +
        `Date@${dateCol}, Hour@${hourCol}, TOU@${touCol}.`,
    );
  }

  const interfaceNames = canonical.slice(KEY_COLS).filter((name) => name.length > 0);
  if (interfaceNames.length === 0) {
    throw new Error('CSV header carries no interface columns after Date, Hour, TOU.');
  }
  return { raw, canonical, dateCol, hourCol, touCol, interfaceNames };
}

/**
 * Union schema across files: every interface name seen in any header, in
 * first-seen order.
 *
 * This is why the picker waits for every dropped file before it opens. Files
 * differ in which paths they monitor -- and a case that is missing from the
 * union can never be picked, so a column offered by one file has to be
 * offered for all of them, with a per-file presence bitmap saying who
 * actually carried it.
 */
export function unionSchema(headers: HeaderInfo[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of headers) {
    for (const name of h.interfaceNames) {
      if (name.length === 0 || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Build the source-column -> cube-interface plan for one file against the
 * retained list. `retained` defines the cube's interface axis and its index
 * order; this file's own column order is irrelevant beyond locating the bytes.
 */
export function buildColumnPlan(header: HeaderInfo, retained: string[]): ColumnPlan {
  const interfaces = retained.map((n) => n.trim());
  const wanted = new Map<string, number>();
  for (let i = 0; i < interfaces.length; i++) {
    if (!wanted.has(interfaces[i])) wanted.set(interfaces[i], i);
  }

  const plan = new Int32Array(header.canonical.length).fill(-1);
  const presence = new Uint8Array(interfaces.length);

  for (let col = KEY_COLS; col < header.canonical.length; col++) {
    const dest = wanted.get(header.canonical[col]);
    if (dest === undefined) continue;
    // A duplicated header name would otherwise double-write one plane;
    // first occurrence wins.
    if (presence[dest]) continue;
    if (col - KEY_COLS >= SLAB_METRICS) {
      throw new Error(
        `Retained column "${header.canonical[col]}" sits at source index ${col}, past ` +
          `parser/block.c's ${SLAB_METRICS}-column slab (max source index ` +
          `${KEY_COLS + SLAB_METRICS - 1}). block.c must be widened and rebuilt.`,
      );
    }
    plan[col] = dest;
    presence[dest] = 1;
  }

  const slabPlan = new Int32Array(SLAB_METRICS).fill(-1);
  const active: number[] = [];
  for (let m = 0; m < SLAB_METRICS; m++) {
    const col = m + KEY_COLS;
    const dest = col < plan.length ? plan[col] : -1;
    slabPlan[m] = dest;
    if (dest >= 0) active.push(m);
  }

  return { interfaces, plan, slabPlan, activePlanes: Int32Array.from(active), presence };
}

/**
 * Cumulative days before each month, non-leap -- the same table block.c
 * uses. Feb 29 is dropped at ingest (D4) so leap years share it.
 */
const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/** Day-of-year (0-based) for a 1-based month/day, or -1 for Feb 29 / invalid. */
export function dayOfYear(month: number, day: number): number {
  if (month < 1 || month > 12 || day < 1 || day > 31) return -1;
  if (month === 2 && day === 29) return -1; // D4: Feb 29 dropped
  return CUM[month - 1] + day - 1;
}
