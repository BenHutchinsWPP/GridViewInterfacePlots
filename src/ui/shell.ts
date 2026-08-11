// src/ui/shell.ts
//
// The control rail, the status sentence, focus mode, keyboard, drag-and-drop.
//
// The rail is fixed and persistent, never a drawer: filters change constantly
// during analysis, and a control you have to open first is a control you use
// less. There is no Apply button -- re-filtering measures well under a
// millisecond, so an Apply button would exist only to hide latency this app
// does not have.
//
// Everything here is a pure function of the frozen Query plus the case list.
// `render()` rebuilds the rail's contents; the containers and their event
// listeners are created once and survive every render.

import { DAY_NAMES, HOURS_PER_YEAR, MONTH_NAMES, SEASON_NAMES, TOU_LABELS } from '../calendar';
import type { CaseData, Filters, PaneView, Query } from '../types';
import { interfaceGroups } from '../rules';
import { createChipGrid } from './chips';

/** Ten categorical colours, assigned at drop time and never reshuffled.
 * A ten-series overlay is only readable if the mapping is learned once,
 * so the legend lives in the rail and nowhere else. */
export const CASE_COLORS = [
  '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
  '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
];

export interface ShellState {
  cases: CaseData[];
  /** Names of the cases currently drawn -- Query.cases, as a fast lookup. */
  enabled: Set<string>;
  /** Interface axis offered in the rail: the union of every case's retained
   * set. */
  interfaces: string[];
  /** Interface -> the case names that carry it, for the rail's "in 1 of 2
   * files" hint. */
  coverage: Map<string, string[]>;
  /** One row per drawn line: the cross product is no longer readable from the
   * case list alone, so the legend names every line it produced. */
  legend: { label: string; color: string }[];
  /** Hours the current filters keep, for the status sentence. */
  keptHours: number;
  bytes: number;
  /** Ingest / load progress, or null when idle. */
  busy: string | null;
}

export interface ShellHandlers {
  onQueryChange(patch: Partial<Query>): void;
  onFiltersChange(patch: Partial<Filters>): void;
  onToggleCase(name: string): void;
  onRemoveCase(name: string): void;
  onFiles(files: File[]): void;
  onAddCases(): void;
  onSave(): void;
  /** Open a saved bundle from disk. */
  onLoad(): void;
}

export interface Shell {
  render(query: Query, state: ShellState): void;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`index.html is missing #${id}`);
  return element as T;
}

/** Collapse a selection into runs: {1,2,3,7} over Jan..Dec -> "Jan–Mar, Jul". */
function summarise<T>(
  selection: ReadonlySet<T> | null,
  ordered: readonly T[],
  label: (value: T) => string,
  everything: string,
): string {
  if (selection === null || selection.size === ordered.length) return everything;
  if (selection.size === 0) return 'nothing';

  const indices = ordered.map((value, index) => (selection.has(value) ? index : -1)).filter((i) => i >= 0);
  const parts: string[] = [];
  let start = indices[0];
  let previous = indices[0];
  for (let i = 1; i <= indices.length; i++) {
    const current = indices[i];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    parts.push(
      start === previous
        ? label(ordered[start])
        : `${label(ordered[start])}–${label(ordered[previous])}`,
    );
    start = current;
    previous = current;
  }
  return parts.join(', ');
}

/** The status bar is a sentence, not a widget: analysts screenshot these
 * panes into decks, and a screenshot that states its own filters removes a
 * whole class of "which filter was this?" mistakes. */
export function statusSentence(query: Query, keptHours: number): string {
  const { filters } = query;
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const hours = Array.from({ length: 24 }, (_, i) => i + 1);
  const days = Array.from({ length: 7 }, (_, i) => i);

  const parts = [
    `${keptHours.toLocaleString()} of ${HOURS_PER_YEAR.toLocaleString()} h`,
    summarise(filters.months, months, (m) => MONTH_NAMES[m - 1], 'all months'),
    summarise(filters.daysOfWeek, days, (d) => DAY_NAMES[d], 'all days'),
  ];
  if (filters.hoursOfDay !== null) {
    parts.push(`HE ${summarise(filters.hoursOfDay, hours, String, 'all')}`);
  }
  if (filters.seasons !== null) {
    parts.push(summarise(filters.seasons, SEASON_NAMES, String, 'all seasons'));
  }
  if (filters.tou !== null) {
    parts.push(summarise(filters.tou, TOU_LABELS, String, 'all TOU'));
  }
  // The interface list is the long axis now; naming ten paths in the status
  // bar would push the filters off the end of it.
  parts.push(
    query.interfaces.length <= 3
      ? query.interfaces.join(' + ')
      : `${query.interfaces.length} interfaces`,
  );
  const plural = query.cases.length === 1 ? '' : 's';
  parts.push(`${query.cases.length} case${plural}`);
  return parts.join(' · ');
}

export function createShell(handlers: ShellHandlers): Shell {
  const casesList = byId('cases-list');
  const interfaceDropdown = byId<HTMLSelectElement>('interface-dropdown');
  const interfaceFilter = byId<HTMLInputElement>('interface-filter');
  const interfaceSummary = byId('interface-summary');
  const seriesLegend = byId('series-legend');
  const statusText = byId('status-text');
  const memoryReadout = byId('memory-readout');
  const chartArea = byId('chart-area');

  // ------------------------------------------------------------ chip grids
  const monthChips = createChipGrid(
    byId('month-chips'),
    MONTH_NAMES.map((label, index) => ({ value: index + 1, label })),
    (next) => handlers.onFiltersChange({ months: next }),
  );
  const hourChips = createChipGrid(
    byId('hour-chips'),
    Array.from({ length: 24 }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
    (next) => handlers.onFiltersChange({ hoursOfDay: next }),
  );
  const dayChips = createChipGrid(
    byId('day-chips'),
    DAY_NAMES.map((label, index) => ({ value: index, label })),
    (next) => handlers.onFiltersChange({ daysOfWeek: next }),
  );
  const seasonChips = createChipGrid(
    byId('season-chips'),
    SEASON_NAMES.map((name) => ({ value: name as string, label: name })),
    (next) => handlers.onFiltersChange({ seasons: next }),
  );
  const touChips = createChipGrid(
    byId('tou-chips'),
    TOU_LABELS.map((name) => ({ value: name as string, label: name })),
    (next) => handlers.onFiltersChange({ tou: next }),
  );

  function resetFilters(): void {
    handlers.onFiltersChange({
      months: null,
      hoursOfDay: null,
      daysOfWeek: null,
      seasons: null,
      tou: null,
    });
  }

  byId('reset-filters-btn').addEventListener('click', resetFilters);

  // Per-filter clear. One delegated listener: the buttons carry their own
  // Filters key, and clearing one is the same "no constraint" null the chip
  // grid commits when a selection would cover every chip (src/types.ts).
  const filtersSection = byId('filters-section');
  filtersSection.addEventListener('click', (event) => {
    const key = (event.target as HTMLElement).closest<HTMLElement>('.filter-clear')?.dataset.filter;
    if (key) handlers.onFiltersChange({ [key]: null } as Partial<Filters>);
  });
  byId<HTMLButtonElement>('add-cases-btn').addEventListener('click', () => handlers.onAddCases());
  byId<HTMLButtonElement>('save-btn').addEventListener('click', () => handlers.onSave());
  byId<HTMLButtonElement>('load-btn').addEventListener('click', () => handlers.onLoad());

  /**
   * What the interface list should become after a click in it.
   *
   * The <select> only ever holds the interfaces matching the filter box, so
   * its selected options are not the whole selection: a path selected under
   * an earlier search is still selected, it is simply not on screen. Keeping
   * those is what makes "search, pick, search again, pick again" work, so the
   * result is (everything selected that is currently hidden) + (what is
   * ticked on screen).
   */
  function selectedInterfaces(shown: string[]): string[] {
    const onScreen = new Set(Array.from(interfaceDropdown.selectedOptions, (o) => o.value));
    const hiddenKept = currentSelection.filter((name) => !shown.includes(name));
    const next = [...hiddenKept, ...shown.filter((name) => onScreen.has(name))];
    // A query with no interface draws nothing and there is no useful state to
    // be in, so an empty result falls back to the first visible path.
    return next.length > 0 ? next : shown.slice(0, 1);
  }

  /** The last rendered query's interface list, for the fold above. */
  let currentSelection: string[] = [];
  /** The interfaces currently in the <select>, in option order. */
  let shownInterfaces: string[] = [];

  interfaceDropdown.addEventListener('change', () => {
    handlers.onQueryChange({ interfaces: selectedInterfaces(shownInterfaces) });
  });
  interfaceFilter.addEventListener('input', () => {
    // Repaint through the app so the rail stays a pure function of the query:
    // the filter box changes what is listed, never what is selected.
    handlers.onQueryChange({});
  });

  casesList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const item = target.closest<HTMLElement>('.case-item');
    if (!item) return;
    const name = item.dataset.case;
    if (!name) return;
    if (target.classList.contains('case-remove')) handlers.onRemoveCase(name);
    else handlers.onToggleCase(name);
  });

  // ------------------------------------------------------------ focus mode
  let view: PaneView = 'grid';

  function setView(next: PaneView): void {
    view = next;
    chartArea.classList.toggle('focus-mode', next !== 'grid');
    for (let pane = 1; pane <= 4; pane++) {
      const focused = next === pane;
      byId(`pane-${pane}`).classList.toggle('focused', focused);
      const icon = byId(`pane-${pane}`).querySelector('.pane-icon');
      if (icon) {
        icon.textContent = focused ? '⤡' : '⤢';
        icon.setAttribute('title', focused ? 'Back to the grid (or press Esc)' : `Expand this pane (or press ${pane})`);
      }
    }
    // No onQueryChange: focus is layout only. The panes re-fit through
    // charts.ts's ResizeObserver, which already watches each pane body.
  }

  for (let pane = 1; pane <= 4; pane++) {
    const header = byId(`pane-${pane}`).querySelector('.pane-header');
    const toggle = () => setView(view === pane ? 'grid' : (pane as PaneView));
    // The ⤢ is a button: one click. Double-clicking the header still works,
    // but a control that looks clickable has to act on the first click.
    header?.querySelector('.pane-icon')?.addEventListener('click', (event) => {
      event.stopPropagation();
      toggle();
    });
    header?.addEventListener('dblclick', toggle);
  }

  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    // Never steal a keystroke from a control the user is actually typing in.
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key >= '1' && event.key <= '4') {
      const pane = Number(event.key) as PaneView;
      setView(view === pane ? 'grid' : pane);
    } else if (event.key === 'Escape') {
      setView('grid');
    } else if (event.key === 'r') {
      resetFilters();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Step through the listed interfaces one at a time -- the fastest way
      // to flip through paths without touching the mouse.
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const at = shownInterfaces.indexOf(currentSelection[currentSelection.length - 1]);
      const next = at + step;
      if (next >= 0 && next < shownInterfaces.length) {
        handlers.onQueryChange({ interfaces: [shownInterfaces[next]] });
      }
      event.preventDefault();
    }
  });

  // ------------------------------------------------------------ drag and drop
  const dropOverlay = document.createElement('div');
  dropOverlay.className = 'drop-overlay';
  dropOverlay.textContent = 'Drop GridView interface CSV exports to load them';
  document.body.appendChild(dropOverlay);

  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth++;
    dropOverlay.classList.add('visible');
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      dropOverlay.classList.remove('visible');
    }
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove('visible');
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) handlers.onFiles(files);
  });

  // ------------------------------------------------------------ render
  return {
    render(query, state) {
      currentSelection = [...query.interfaces];

      // CASES — the legend lives here, once, and nowhere else. A case is one
      // file, so its quantity ("Power Flow (MW)") is a property of the case
      // and is named next to it: two cases of different quantities overlay on
      // two axes and the case list is where that is explained.
      casesList.replaceChildren();
      if (state.cases.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'case-empty';
        empty.textContent = 'Drop CSV exports anywhere on this window.';
        casesList.appendChild(empty);
      }
      state.cases.forEach((data, index) => {
        const item = document.createElement('div');
        item.className = 'case-item' + (state.enabled.has(data.name) ? ' case-on' : '');
        item.dataset.case = data.name;

        const swatch = document.createElement('span');
        swatch.className = 'case-swatch';
        swatch.style.background = CASE_COLORS[index % CASE_COLORS.length];
        item.appendChild(swatch);

        const label = document.createElement('span');
        label.className = 'case-name';
        label.textContent = data.name;
        const quantity = data.quantity || 'unknown quantity';
        label.title = `${data.name} — ${quantity}, ${data.year}, ${data.interfaces.length} interfaces`;
        item.appendChild(label);

        const tag = document.createElement('span');
        tag.className = 'case-tag';
        tag.textContent = data.unit || '?';
        tag.title = quantity;
        item.appendChild(tag);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'case-remove';
        remove.textContent = '×';
        remove.title = 'Remove this case';
        item.appendChild(remove);

        casesList.appendChild(item);
      });

      // INTERFACES. The filter box narrows what is listed; the selection is
      // the query's, so a path picked under a previous search stays picked
      // and simply is not on screen.
      const needle = interfaceFilter.value.trim().toLowerCase();
      const matching = needle
        ? state.interfaces.filter((name) => name.toLowerCase().includes(needle))
        : state.interfaces;
      const groups = interfaceGroups(matching, state.coverage, state.cases.length);
      shownInterfaces = groups.flatMap((group) => group.names);

      const signature = `${needle}\u0000${shownInterfaces.join('')}`;
      if (interfaceDropdown.dataset.signature !== signature) {
        interfaceDropdown.dataset.signature = signature;
        interfaceDropdown.replaceChildren();
        for (const { title, names } of groups) {
          const group = document.createElement('optgroup');
          group.label = title;
          for (const name of names) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            const carriers = state.coverage.get(name)?.length ?? 0;
            if (state.cases.length > 1 && carriers < state.cases.length) {
              option.title = `In ${carriers} of ${state.cases.length} cases`;
            }
            group.appendChild(option);
          }
          interfaceDropdown.appendChild(group);
        }
      }
      const wanted = new Set(query.interfaces);
      for (const option of interfaceDropdown.options) option.selected = wanted.has(option.value);

      const offScreen = query.interfaces.filter((name) => !shownInterfaces.includes(name)).length;
      interfaceSummary.textContent =
        `${query.interfaces.length} selected` +
        (offScreen > 0 ? ` · ${offScreen} not shown by this filter` : '') +
        ` · ${matching.length} of ${state.interfaces.length} listed`;

      // The legend: one row per drawn line, in draw order, so the colour of a
      // "case · interface" line can be read off without hovering it.
      seriesLegend.replaceChildren();
      for (const entry of state.legend) {
        const row = document.createElement('div');
        row.className = 'series-legend-row';
        const swatch = document.createElement('span');
        swatch.className = 'case-swatch';
        swatch.style.background = entry.color;
        row.appendChild(swatch);
        const label = document.createElement('span');
        label.textContent = entry.label;
        label.title = entry.label;
        row.appendChild(label);
        seriesLegend.appendChild(row);
      }

      // FILTERS
      monthChips.render(query.filters.months);
      hourChips.render(query.filters.hoursOfDay);
      dayChips.render(query.filters.daysOfWeek);
      seasonChips.render(query.filters.seasons);
      touChips.render(query.filters.tou);
      for (const button of filtersSection.querySelectorAll<HTMLButtonElement>('.filter-clear')) {
        button.disabled = query.filters[button.dataset.filter as keyof Filters] === null;
      }

      statusText.textContent = state.busy ?? statusSentence(query, state.keptHours);
      memoryReadout.textContent =
        `${(state.bytes / (1024 * 1024)).toFixed(1)} MB · ` +
        `${state.cases.length} case${state.cases.length === 1 ? '' : 's'}`;
    },
  };
}
