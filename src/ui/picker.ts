// src/ui/picker.ts
//
// The interface picker, shown on the first drop and skippable (D6).
//
// Two things make this more than a checkbox list:
//
//   * It opens over the UNION of every dropped file's header (D14). Runs
//     monitor different sets of paths, and a column that is offered by one
//     file has to be offered for all of them or it can never be selected at
//     all -- so the list says which files carry a path, and a case that does
//     not carries it as absent rather than as zero.
//   * Selection narrows the cube's interface axis itself, not just the parse,
//     and the readout below is the real allocation arithmetic rather than an
//     estimate. At this shape memory is not the binding constraint it was for
//     the area exports -- a full 167-interface year is ~6 MB -- so the default
//     is everything and the picker's real job is keeping 167 paths out of the
//     rail when you care about four of them.

import { cubeBytesFor } from '../ingest/pool';
import { interfaceGroups } from '../rules';

/**
 * Resolve to the retained interface list, or to `union` unchanged if the user
 * skips. `coverage` maps interface -> the case names whose header carries it.
 */
export function showPicker(
  union: string[],
  coverage: Map<string, string[]>,
  caseCount: number,
): Promise<string[]> {
  return new Promise((resolve) => {
    const chosen = new Set(union);

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'modal';
    backdrop.appendChild(modal);

    const title = document.createElement('h2');
    title.textContent = 'Which interfaces should be kept?';
    modal.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent =
      caseCount > 1
        ? `Every path monitored by any of these ${caseCount} files is listed. Keep the lot, or ` +
          'narrow it now — what you keep here is what the rail offers later.'
        : 'Every path this export monitors is listed. Keep the lot, or narrow it now — what ' +
          'you keep here is what the rail offers later.';
    modal.appendChild(subtitle);

    const toolbar = document.createElement('div');
    toolbar.className = 'modal-toolbar';
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.placeholder = 'Filter interfaces…';
    filter.className = 'modal-filter';
    toolbar.appendChild(filter);

    // Select all/none act on WHAT THE FILTER SHOWS. With 167 paths the filter
    // is how a selection gets built -- type "P8", take those, type "Malin",
    // add those -- and a "Select all" that quietly took the other 150 back
    // would make that impossible.
    const selectAll = document.createElement('button');
    selectAll.type = 'button';
    selectAll.className = 'btn';
    selectAll.textContent = 'Select all';
    toolbar.appendChild(selectAll);

    const selectNone = document.createElement('button');
    selectNone.type = 'button';
    selectNone.className = 'btn';
    selectNone.textContent = 'Select none';
    toolbar.appendChild(selectNone);
    modal.appendChild(toolbar);

    const list = document.createElement('div');
    list.className = 'modal-list';
    modal.appendChild(list);

    const readout = document.createElement('p');
    readout.className = 'modal-readout';
    modal.appendChild(readout);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn';
    skip.textContent = 'Keep everything';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary';
    confirm.textContent = 'Load with these';
    actions.append(skip, confirm);
    modal.appendChild(actions);

    /** Folders the user has opened or closed, by title. */
    const openState = new Map<string, boolean>();

    function visible(): string[] {
      const needle = filter.value.trim().toLowerCase();
      return needle ? union.filter((name) => name.toLowerCase().includes(needle)) : union;
    }

    function paint(): void {
      const needle = filter.value.trim().toLowerCase();
      list.replaceChildren();

      for (const { title: groupTitle, names } of interfaceGroups(visible(), coverage, caseCount)) {
        const folder = document.createElement('details');
        folder.dataset.group = groupTitle;
        // A filter opens everything -- a hit inside a closed folder is a hit
        // the user cannot see. Otherwise the folder remembers what the user
        // last did to it, which has to survive both a repaint and a filter
        // that hid the folder entirely.
        folder.open = needle ? true : (openState.get(groupTitle) ?? true);

        const summary = document.createElement('summary');
        summary.className = 'picker-folder';
        // Recorded on click, not on the toggle event: painting sets `open`
        // programmatically and that fires toggle too.
        summary.addEventListener('click', () => openState.set(groupTitle, !folder.open));
        const label = document.createElement('span');
        label.textContent = groupTitle;
        summary.appendChild(label);
        const count = document.createElement('span');
        count.className = 'picker-count';
        count.textContent = `${names.filter((n) => chosen.has(n)).length}/${names.length}`;
        summary.appendChild(count);
        folder.appendChild(summary);

        for (const name of names) {
          const row = document.createElement('label');
          row.className = 'modal-row';

          const box = document.createElement('input');
          box.type = 'checkbox';
          box.value = name;
          box.checked = chosen.has(name);
          row.appendChild(box);

          const text = document.createElement('span');
          text.className = 'modal-row-name';
          text.textContent = name;
          row.appendChild(text);

          const carriers = coverage.get(name) ?? [];
          if (caseCount > 1 && carriers.length < caseCount) {
            row.title = `Only in ${carriers.join(', ')}. The other file(s) load it as no-data.`;
            const flag = document.createElement('span');
            flag.className = 'picker-count';
            flag.textContent = `${carriers.length}/${caseCount}`;
            row.appendChild(flag);
          }

          box.addEventListener('change', () => {
            if (box.checked) chosen.add(name);
            else chosen.delete(name);
            paint();
          });
          folder.appendChild(row);
        }
        list.appendChild(folder);
      }

      // Exactly what ingest will allocate: retained x cases x hours x 4.
      const bytes = cubeBytesFor(chosen.size) * caseCount;
      skip.title = `All ${union.length} interfaces ≈ ${(
        (cubeBytesFor(union.length) * caseCount) /
        (1024 * 1024)
      ).toFixed(0)} MB`;
      readout.textContent =
        `${chosen.size} of ${union.length} interface${union.length === 1 ? '' : 's'} × ` +
        `${caseCount} case${caseCount === 1 ? '' : 's'} ≈ ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      confirm.disabled = chosen.size === 0;
    }

    filter.addEventListener('input', paint);
    selectAll.addEventListener('click', () => {
      for (const name of visible()) chosen.add(name);
      paint();
    });
    selectNone.addEventListener('click', () => {
      for (const name of visible()) chosen.delete(name);
      paint();
    });

    function close(result: string[]): void {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    // Escape takes what is on screen, which is everything until the user
    // changes it: dismissing a dialog should never be the choice that loses
    // data.
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape' && chosen.size > 0) close([...chosen]);
    }
    document.addEventListener('keydown', onKey);
    skip.addEventListener('click', () => close(union));
    confirm.addEventListener('click', () => close([...chosen]));

    paint();
    document.body.appendChild(backdrop);
    filter.focus();
  });
}
