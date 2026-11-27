// The interface: draws the week, runs the dialogs, and saves after every change.

import * as logic from './logic.js';
import * as storage from './storage.js';
import { buildPdf, textOn } from './pdf.js';
import { timeField } from './timefield.js';

const COLORS = [
  ['Blue', '#00548E'], ['Orange', '#FF8300'], ['Sky', '#148CC5'], ['Green', '#2C9043'],
  ['Teal', '#139979'], ['Lime', '#76BD22'], ['Red', '#CE1141'], ['Coral', '#F35B2A'],
  ['Purple', '#6B3FA0'], ['Pink', '#C2447F'], ['Navy', '#002345'], ['Slate', '#73859F'],
];

const $ = (selector) => document.querySelector(selector);
const dialog = $('#dialog');
const toastBox = $('#toast');
const newId = () => crypto.randomUUID();

let { state, warning, locked } = storage.load();
let week = logic.weekStart(logic.todayISO());
let toastTimer;
let branchId = storage.lastBranch();
// The branch being looked at: its people and notes.
const view = () => logic.branchView(state, branchId);

function switchBranch(id) {
  branchId = id;
  storage.rememberBranch(id);
  hideToast();
  render();
}

// Tiny helper for building elements. Text is always inserted as text, never as HTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}
const button = (label, onclick, props = {}) => el('button', { type: 'button', onclick, ...props }, label);
const field = (label, control, hint) => el('label', { className: 'field' }, label, control, hint);

const tagOf = (person) => state.tags.find((t) => t.id === person.tagId);
const tagColor = (person) => tagOf(person)?.color ?? '#73859F';
const paint = (node, color) => {
  node.style.backgroundColor = color;
  node.style.color = textOn(color);
  return node;
};

// ---------- saving ----------

function showWarning(message) {
  $('#warning').textContent = message ?? '';
  $('#warning').hidden = !message;
}

function persist() {
  if (locked) return;
  const ok = storage.save(state);
  showWarning(ok ? null : 'Your last change could NOT be saved (storage may be full or blocked). Use Backup to download a copy now.');
}

// Every edit goes through here. With `message`, an Undo button is offered.
function change(mutate, message) {
  const before = structuredClone(state);
  mutate();
  persist();
  render();
  if (message) {
    toast(message, () => {
      state = before;
      persist();
      render();
    });
  } else {
    hideToast(); // an older Undo would also revert this newer change
  }
}

function hideToast() {
  clearTimeout(toastTimer);
  toastBox.hidden = true;
}

function toast(message, undo) {
  hideToast();
  toastBox.replaceChildren(el('span', {}, message));
  if (undo) toastBox.append(button('Undo', () => {
    hideToast();
    if (dialog.open) closeDialog(); // its contents would be out of date
    undo();
  }));
  // A modal dialog blocks the rest of the page, so the toast has to sit inside it.
  (dialog.open ? dialog : document.body).append(toastBox);
  toastBox.hidden = false;
  toastTimer = setTimeout(hideToast, 10000);
}

// ---------- drawing the week ----------

function visibleDates() {
  const dates = logic.weekDates(week);
  const sunday = dates[0];
  // Sunday is always shown if someone is scheduled then, so no hours are ever hidden.
  const needed = state.showSunday || view().people.some((p) => state.shifts[sunday]?.[p.id]);
  return needed ? dates : dates.slice(1);
}

function render() {
  $('#week-label').textContent = logic.weekLabel(week);
  $('#jump').value = week;
  $('#show-sunday').checked = state.showSunday;
  renderBranches();
  renderBanner();
  renderSchedule();
  renderBackupNote();
}

function renderBranches() {
  const current = view().branch;
  $('#print-branch').textContent = `${current.name} · `;
  $('#branches').replaceChildren(...state.branches.map((b) =>
    button(b.name, () => switchBranch(b.id), { 'aria-pressed': String(b.id === current.id) })));
}

function renderBanner() {
  const banner = $('#banner');
  const results = view().people.map((person) => ({ person, summary: logic.weekSummary(state, person, week) }));
  const off = results.filter((r) => r.summary.status !== 'on');
  const gaps = logic.coverageGaps(view(), week);
  banner.className = `banner ${off.length || gaps.length ? 'attention' : 'good'}`;
  if (!results.length) return banner.replaceChildren();

  const content = [];
  if (gaps.length) {
    content.push(el('div', {}, 'Required positions are missing:',
      el('ul', {}, gaps.map((gap) => el('li', {}, `${dayName(gap.date)}: ${logic.gapSentence(gap)}`)))));
  }
  if (!off.length) {
    content.push(el('div', {}, 'Everyone is right on their target hours this week.'));
  } else {
    const over = off.filter((r) => r.summary.status === 'over').length;
    const under = off.length - over;
    const parts = [over && `${over} over`, under && `${under} under`].filter(Boolean).join(' and ');
    content.push(el('div', {}, `This week: ${parts} target hours.`,
      el('ul', {}, off.map((r) => el('li', {}, `${r.person.name}: ${logic.statusSentence(r.person, r.summary)}`)))));
  }
  banner.replaceChildren(...content);
}

const dayName = (date) => logic.formatDate(date, { weekday: 'short', month: 'numeric', day: 'numeric' });

function renderSchedule() {
  const root = $('#schedule');
  const { people, notes, branch } = view();
  if (!people.length) {
    root.replaceChildren(el('div', { className: 'empty' },
      el('h3', {}, `Add the first team member for ${branch.name}`),
      el('p', {}, 'Give them a name, a position, full or part time, and weekly hours. Then click any day to schedule them.'),
      el('p', {}, button('+ Add person', () => personDialog(), { className: 'primary' })),
    ));
    return;
  }

  const dates = visibleDates();
  const today = logic.todayISO();
  const gaps = logic.coverageGaps(view(), week);
  const head = el('tr', {},
    el('th', { className: 'name-col', scope: 'col' }, 'Team member'),
    dates.map((date) => el('th', { className: date === today ? 'today' : '', scope: 'col' },
      dayName(date),
      gaps.filter((gap) => gap.date === date).map((gap) => el('span', { className: 'gap', title: logic.gapSentence(gap) },
        `Needs ${gap.name}`)))),
    el('th', { className: 'total-col', scope: 'col' }, 'Week total'),
  );

  const rows = people.map((person) => {
    const tag = tagOf(person);
    const summary = logic.weekSummary(state, person, week);
    return el('tr', {},
      el('th', { scope: 'row' }, button([
        el('strong', {}, person.name),
        tag ? paint(el('span', { className: 'chip' }, tag.name), tag.color) : el('small', {}, 'No position'),
        el('small', {}, EMPLOYMENT[person.employment]),
      ], () => personDialog(person), { className: 'person', title: `Edit ${person.name}` })),
      dates.map((date) => el('td', { className: 'day' }, dayCell(person, date))),
      el('td', { className: 'total-cell' }, el('div', { className: `total ${summary.status}` },
        el('b', {}, `${logic.formatHours(summary.minutes)} h`),
        el('span', {}, logic.statusSentence(person, summary)))),
    );
  });

  const hasNotes = dates.some((date) => notes[date]);
  const noteRow = el('tr', { className: hasNotes ? 'notes' : 'notes blank' },
    el('th', { scope: 'row' }, 'Schedule Notes'),
    dates.map((date) => el('td', {}, noteCell(date))),
    el('td', {}));

  root.replaceChildren(el('div', { className: 'table-wrap' },
    el('table', {}, el('thead', {}, head), el('tbody', {}, noteRow, rows))));
}

function noteCell(date) {
  const note = view().notes[date];
  const day = logic.formatDate(date, { weekday: 'long', month: 'long', day: 'numeric' });
  return button(note ?? '+ Note', () => noteDialog(date), {
    className: note ? 'note' : 'note off',
    'aria-label': note ? `Note for ${day}: ${note}. Edit note` : `Add a note for ${day}`,
  });
}

function noteDialog(date) {
  const { branch, notes } = view();
  const existing = notes[date];
  const input = el('textarea', { rows: 3, maxLength: logic.NOTE_LENGTH, value: existing ?? '' });
  const save = (value, message) => {
    closeDialog();
    change(() => {
      const target = state.branches.find((b) => b.id === branch.id);
      target.notes = logic.setNote(target.notes, date, value);
    }, message);
  };
  const form = el('form', { className: 'list', onsubmit: (e) => { e.preventDefault(); save(input.value); } },
    field('Note', input, el('span', { className: 'hint' }, `Shown at the top of this day, and on printouts. Up to ${logic.NOTE_LENGTH} characters.`)),
    el('div', { className: 'actions' },
      existing && button('Remove note', () => save('', 'Note removed.'), { className: 'danger left' }),
      button('Cancel', closeDialog),
      el('button', { type: 'submit', className: 'primary' }, 'Save note')),
  );
  // Enter saves; a note is a single short paragraph.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); form.requestSubmit(); }
  });
  openDialog(`Schedule note · ${logic.formatDate(date, { weekday: 'long', month: 'short', day: 'numeric' })}`, form);
  input.focus();
}

function dayCell(person, date) {
  const info = logic.dayInfo(state, person, date);
  const when = `${person.name}, ${logic.formatDate(date, { weekday: 'long', month: 'long', day: 'numeric' })}`;

  if (info.type === 'holiday') {
    return el('div', { className: 'slot holiday', title: info.name },
      el('strong', {}, info.name),
      el('small', {}, info.minutes ? `+${logic.formatHours(info.minutes)} h` : 'Closed'));
  }
  if (info.type === 'shift') {
    const { shift } = info;
    const meal = logic.mealLabel(shift);
    return paint(button([
      el('strong', {}, logic.shiftLabel(shift)),
      meal && el('small', {}, meal),
      el('small', {}, `${logic.formatHours(info.minutes)} h`),
    ], () => shiftDialog(person, date), { className: 'slot shift', 'aria-label': `${when}: ${logic.shiftLabel(shift)}${meal ? `, ${meal}` : ''}. Edit shift` }),
    tagColor(person));
  }
  return button('+', () => shiftDialog(person, date), { className: 'slot off', 'aria-label': `${when}: add shift` });
}

function renderBackupNote() {
  const last = storage.lastBackup();
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  let note = '';
  if (state.people.length) {
    if (last === null) note = 'Tip: download a backup file from the Backup button.';
    else if (days >= 14) note = `Your last backup was ${days} days ago.`;
    else note = `Last backup: ${new Date(last).toLocaleDateString('en-US')}.`;
  }
  $('#backup-note').textContent = note;
}

// ---------- dialogs ----------

function openDialog(title, ...content) {
  dialog.replaceChildren(el('div', { className: 'dialog-body' }, el('h2', {}, title), content), toastBox);
  if (!dialog.open) dialog.showModal();
}
const closeDialog = () => dialog.close();
dialog.addEventListener('close', () => { if (!dialog.open) document.body.append(toastBox); });

function colorPicker(selected, onPick) {
  const wrap = el('div', { className: 'swatches', role: 'group', 'aria-label': 'Color' });
  for (const [name, color] of COLORS) {
    const swatch = button('', () => {
      for (const other of wrap.children) other.setAttribute('aria-pressed', String(other === swatch));
      onPick(color);
    }, { title: name, 'aria-label': name, 'aria-pressed': String(color === selected) });
    swatch.style.background = color;
    wrap.append(swatch);
  }
  return wrap;
}

const nextColor = () => COLORS[state.tags.length % COLORS.length][1];

const lunchSelect = (value) => el('select', {},
  logic.LUNCH_CHOICES.map((m) => el('option', { value: String(m), selected: m === value }, m ? `${m} minutes` : 'No lunch')));

const EMPLOYMENT = { full: 'Full time', part: 'Part time' };

function personDialog(person) {
  const NEW = '__new';
  let color = nextColor();
  const name = el('input', { type: 'text', value: person?.name ?? '', maxLength: 60, required: true, autocomplete: 'off' });
  const position = el('select', {},
    el('option', { value: '' }, 'No position'),
    state.tags.map((t) => el('option', { value: t.id, selected: t.id === person?.tagId }, t.name)),
    el('option', { value: NEW }, '+ Create a new position…'));
  if (!person && !state.tags.length) position.value = NEW;

  const tagName = el('input', { type: 'text', maxLength: 40, placeholder: 'Position name', autocomplete: 'off' });
  const newTag = el('fieldset', { className: 'field' },
    el('legend', {}, 'New position'), tagName, colorPicker(color, (c) => { color = c; }));
  const toggleNewTag = () => { newTag.hidden = position.value !== NEW; };
  position.addEventListener('change', toggleNewTag);
  toggleNewTag();

  const target = el('input', { type: 'number', min: '0', max: '168', step: '0.25', value: String(person?.weeklyTarget ?? logic.DEFAULT_HOURS.full), required: true });
  const holidayHint = el('span', { className: 'hint' });
  let employment = person?.employment ?? 'full';
  let hoursTouched = Boolean(person);
  const updateHint = () => {
    const minutes = logic.holidayMinutes({ employment, weeklyTarget: Number(target.value) });
    holidayHint.textContent = minutes
      ? `Each holiday counts as ${logic.formatHours(minutes)} hours.`
      : 'Holidays are blacked out but add no hours.';
  };
  const choices = el('fieldset', { className: 'field' },
    el('legend', {}, 'Employment'),
    el('div', { className: 'segmented' }, Object.entries(EMPLOYMENT).map(([value, label]) => el('label', {},
      el('input', {
        type: 'radio', name: 'employment', value, checked: value === employment,
        onchange: () => {
          employment = value;
          // Suggest the usual hours until she enters her own.
          if (!hoursTouched) target.value = String(logic.DEFAULT_HOURS[value]);
          updateHint();
        },
      }),
      el('span', {}, label)))));
  target.addEventListener('input', () => { hoursTouched = true; updateHint(); });
  updateHint();
  const home = el('select', {}, state.branches.map((b) =>
    el('option', { value: b.id, selected: b.id === (person?.branchId ?? view().branch.id) }, b.name)));
  const error = el('p', { className: 'error', role: 'alert' });

  function submit(addAnother) {
    const cleanName = name.value.trim();
    const hours = Number(target.value);
    if (!cleanName) { error.textContent = 'Enter a name.'; return name.focus(); }
    if (target.value === '' || !(hours >= 0 && hours <= 168)) { error.textContent = 'Enter weekly hours between 0 and 168.'; return target.focus(); }
    const wantsNew = position.value === NEW;
    const label = tagName.value.trim();
    if (wantsNew && !label && state.tags.length) { error.textContent = 'Name the new position, or pick another option.'; return tagName.focus(); }

    const destination = state.branches.find((b) => b.id === home.value);
    const moved = person && person.branchId !== destination.id;
    // A new person added to another branch: show that branch, so they don't seem to vanish.
    if (!person && destination.id !== view().branch.id) switchBranch(destination.id);
    change(() => {
      let tagId = wantsNew ? null : position.value || null;
      if (wantsNew && label) {
        const existing = state.tags.find((t) => t.name.toLowerCase() === label.toLowerCase());
        tagId = existing?.id ?? newId();
        if (!existing) state.tags.push({ id: tagId, name: label, color, required: false });
      }
      const values = { name: cleanName, tagId, employment, weeklyTarget: hours, branchId: destination.id };
      if (person) Object.assign(state.people.find((p) => p.id === person.id), values);
      else state.people.push({ id: newId(), ...values });
    }, moved ? `${cleanName} moved to ${destination.name}.` : undefined);
    storage.requestPersistence();

    if (addAnother) {
      personDialog();
      toast(`${cleanName} added.`);
    } else closeDialog();
  }

  // Order is changed among the people of the same branch.
  const peers = person ? state.people.filter((p) => p.branchId === person.branchId) : [];
  const index = peers.findIndex((p) => p.id === person?.id);
  const move = (step) => {
    const other = peers[index + step];
    if (!other) return;
    change(() => {
      const from = state.people.findIndex((p) => p.id === person.id);
      const to = state.people.findIndex((p) => p.id === other.id);
      [state.people[from], state.people[to]] = [state.people[to], state.people[from]];
    });
    personDialog(state.people.find((p) => p.id === person.id));
  };

  const remove = () => {
    if (!confirm(`Remove ${person.name} and all of their shifts?`)) return;
    closeDialog();
    change(() => {
      state.people = state.people.filter((p) => p.id !== person.id);
      for (const [date, day] of Object.entries(state.shifts)) {
        delete day[person.id];
        if (!Object.keys(day).length) delete state.shifts[date];
      }
    }, `${person.name} removed.`);
  };

  const form = el('form', { className: 'list', noValidate: true, onsubmit: (e) => { e.preventDefault(); submit(false); } },
    field('Name', name),
    state.branches.length > 1 && field('Branch', home),
    field('Position', position),
    newTag,
    choices,
    field('Weekly hours', target),
    holidayHint,
    person && el('div', { className: 'row' }, 'Order in list:',
      button('Move up', () => move(-1), { disabled: index === 0 }),
      button('Move down', () => move(1), { disabled: index === peers.length - 1 })),
    error,
    el('div', { className: 'actions' },
      person && button('Remove person', remove, { className: 'danger left' }),
      button('Cancel', closeDialog),
      !person && button('Save & add another', () => submit(true)),
      el('button', { type: 'submit', className: 'primary' }, 'Save')),
  );

  openDialog(person ? `Edit ${person.name}` : 'Add a team member', form);
  name.focus();
}

// The most recently scheduled distinct shift times, newest first. This person's come first.
function recentShifts(personId) {
  const own = [];
  const others = [];
  for (const date of Object.keys(state.shifts).sort().reverse()) {
    for (const [id, shift] of Object.entries(state.shifts[date])) (id === personId ? own : others).push({ date, shift });
  }
  const unique = new Map();
  for (const item of [...own, ...others]) {
    const key = `${item.shift.start}|${item.shift.end}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return { own, presets: [...unique.values()].slice(0, 5) };
}

function shiftDialog(person, date) {
  const existing = state.shifts[date]?.[person.id];
  const { own, presets } = recentShifts(person.id);
  // New shifts start from their latest times on the same kind of day.
  const similar = own.find((item) => logic.isWeekend(item.date) === logic.isWeekend(date))?.shift;
  const usual = logic.isWeekend(date) ? { start: '09:00', end: '15:00' } : { start: '09:00', end: '18:00' };
  const initial = existing ?? {
    ...(similar ?? usual),
    lunch: logic.defaultLunch(date),
    lunchStart: logic.defaultLunchStart(state, person.id, date),
  };

  const update = () => refresh();
  const start = timeField({ label: 'Start', value: initial.start, onChange: update });
  const end = timeField({ label: 'End', value: initial.end, onChange: update });
  const lunch = lunchSelect(initial.lunch);
  const lunchStart = timeField({
    label: 'Lunch starts',
    value: initial.lunchStart,
    // Only offer times where the whole lunch fits inside the shift.
    range: () => [
      logic.timeToMinutes(start.get()) ?? 6 * 60,
      (logic.timeToMinutes(end.get()) ?? 21 * 60) - Number(lunch.value),
    ],
    onChange: update,
  });
  const preview = el('p', { className: 'preview', 'aria-live': 'polite' });
  const error = el('p', { className: 'error', role: 'alert' });

  const otherDays = visibleDates().filter((d) => d !== date && logic.holidayName(d, state.holidayEdits) === null);
  const boxes = otherDays.map((d) => el('input', { type: 'checkbox', value: d }));

  const read = () => ({
    start: start.get(),
    end: end.get(),
    lunch: Number(lunch.value),
    lunchStart: Number(lunch.value) ? lunchStart.get() : null,
  });
  const chosenDates = () => [date, ...boxes.filter((b) => b.checked).map((b) => b.value)];
  // The shift as it would be saved on each chosen day.
  const planned = (shift) => chosenDates().map((d) => [d, logic.adaptShift(state, person.id, shift, date, d)]);

  function problemWith(shift) {
    if (shift.lunch && !lunchStart.isBlank() && !shift.lunchStart) return 'Enter a valid lunch start time, or leave it blank.';
    const first = logic.shiftProblem(shift);
    if (first) return first;
    for (const [d, other] of planned(shift)) {
      const problem = logic.shiftProblem(other);
      if (problem) return `${logic.formatDate(d, { weekday: 'long' })}: ${problem}`;
    }
    return null;
  }

  // Shows what the week total would become before she saves.
  function refresh() {
    lunchStart.node.hidden = lunch.value === '0';
    const shift = read();
    const problem = problemWith(shift);
    error.textContent = '';
    if (problem) { preview.textContent = problem; return; }
    const entries = planned(shift);
    const trial = { ...state, shifts: { ...state.shifts } };
    for (const [d, other] of entries) trial.shifts[d] = { ...trial.shifts[d], [person.id]: other };
    const summary = logic.weekSummary(trial, person, week);
    const differs = entries.some(([, other]) => other.lunch !== shift.lunch);
    preview.textContent = `This shift: ${logic.formatHours(logic.paidMinutes(shift))} paid hours. Week: ${logic.statusSentence(person, summary)}`
      + (differs ? ' Extra days get their usual lunch: 45 minutes on weekdays, 30 on weekends.' : '');
  }

  function submit(event) {
    event.preventDefault();
    const shift = read();
    const problem = problemWith(shift);
    if (problem) { error.textContent = problem; return; }
    const entries = planned(shift);
    const replaced = entries.slice(1).filter(([d]) => state.shifts[d]?.[person.id]).length;
    closeDialog();
    change(() => {
      for (const [d, other] of entries) {
        state.shifts[d] ??= {};
        state.shifts[d][person.id] = other;
      }
    }, replaced ? `Saved to ${entries.length} days, replacing ${replaced} existing.` : undefined);
  }

  const remove = () => {
    closeDialog();
    change(() => {
      delete state.shifts[date][person.id];
      if (!Object.keys(state.shifts[date]).length) delete state.shifts[date];
    }, 'Shift removed.');
  };

  // Choosing a lunch length after "No lunch" brings back a start time.
  lunch.addEventListener('change', () => {
    if (lunch.value !== '0' && lunchStart.isBlank()) lunchStart.set(logic.defaultLunchStart(state, person.id, date));
  });

  const form = el('form', { className: 'list', noValidate: true, onsubmit: submit, oninput: update, onchange: update },
    presets.length > 0 && el('div', { className: 'row presets' }, 'Recent:',
      presets.map((item) => button(logic.shiftLabel(item.shift), () => {
        const next = logic.adaptShift(state, person.id, item.shift, item.date, date);
        start.set(next.start);
        end.set(next.end);
        lunch.value = String(next.lunch);
        lunchStart.set(next.lunchStart);
        refresh();
      }))),
    el('p', { className: 'hint' }, 'Pick a time from the list, or type it: 845 or 2:15p.'),
    el('div', { className: 'pair' }, start.node, end.node),
    el('div', { className: 'pair' }, field('Lunch (unpaid)', lunch), lunchStart.node),
    otherDays.length > 0 && el('fieldset', { className: 'field' },
      el('legend', {}, 'Also use these times on'),
      el('div', { className: 'row' }, otherDays.map((d, i) => el('label', { className: 'check' },
        boxes[i], logic.formatDate(d, { weekday: 'short' }))))),
    preview,
    error,
    el('div', { className: 'actions' },
      existing && button('Remove shift', remove, { className: 'danger left' }),
      button('Cancel', closeDialog),
      // Focused first, so a time list doesn't pop open as soon as the dialog does.
      el('button', { type: 'submit', className: 'primary', autofocus: true }, 'Save shift')),
  );

  openDialog(`${person.name} · ${logic.formatDate(date, { weekday: 'long', month: 'short', day: 'numeric' })}`, form);
  refresh();
}

function branchesDialog() {
  const taken = (label, exceptId) => state.branches.some((b) => b.id !== exceptId && b.name.toLowerCase() === label.toLowerCase());
  const name = el('input', { type: 'text', maxLength: 40, placeholder: 'New branch name', 'aria-label': 'New branch name', autocomplete: 'off' });

  const add = (event) => {
    event.preventDefault();
    const label = name.value.trim();
    if (!label) return name.focus();
    if (taken(label)) return toast('There is already a branch with that name.');
    const id = newId();
    change(() => state.branches.push({ id, name: label, notes: {} }));
    switchBranch(id);
    branchesDialog();
  };

  const items = state.branches.map((branch) => {
    const count = state.people.filter((p) => p.branchId === branch.id).length;
    const only = state.branches.length === 1;
    return el('div', { className: 'item' },
      el('div', { className: 'row' },
        el('input', {
          type: 'text', value: branch.name, maxLength: 40, 'aria-label': 'Branch name',
          onchange: (e) => {
            const label = e.target.value.trim();
            if (!label || taken(label, branch.id)) {
              if (label) toast('There is already a branch with that name.');
              e.target.value = state.branches.find((b) => b.id === branch.id).name;
              return;
            }
            change(() => { state.branches.find((b) => b.id === branch.id).name = label; });
          },
        }),
        button('Delete', () => {
          if (Object.keys(branch.notes).length && !confirm(`Delete "${branch.name}" and its schedule notes?`)) return;
          change(() => { state.branches = state.branches.filter((b) => b.id !== branch.id); }, 'Branch deleted.');
          branchesDialog();
        }, { className: 'danger', disabled: only || count > 0 })),
      el('span', { className: 'hint' }, `${count} ${count === 1 ? 'person' : 'people'}`
        + (count && !only ? '. Move or remove them before deleting this branch.' : '')));
  });

  openDialog('Branches',
    el('p', { className: 'hint' }, 'Type over a name to rename it. Each branch has its own team, schedule and notes. Positions and holidays are shared.'),
    el('div', { className: 'list' }, items),
    el('form', { className: 'item', onsubmit: add },
      el('div', { className: 'row' }, name, el('button', { type: 'submit', className: 'primary' }, 'Add branch'))),
    el('div', { className: 'actions' }, button('Done', closeDialog)),
  );
}

function positionsDialog() {
  let color = nextColor();
  const name = el('input', { type: 'text', maxLength: 40, placeholder: 'New position name', autocomplete: 'off' });

  const requiredBox = (checked, props = {}) => {
    const box = el('input', { type: 'checkbox', checked, ...props });
    return { box, row: el('label', { className: 'check' }, box, 'Required to open and close') };
  };
  const required = requiredBox(false);

  const add = (event) => {
    event.preventDefault();
    const label = name.value.trim();
    if (!label) return name.focus();
    if (state.tags.some((t) => t.name.toLowerCase() === label.toLowerCase())) return toast('That position already exists.');
    change(() => state.tags.push({ id: newId(), name: label, color, required: required.box.checked }));
    positionsDialog();
  };

  const items = state.tags.map((tag) => {
    const used = state.people.filter((p) => p.tagId === tag.id).length;
    return el('div', { className: 'item' },
      el('div', { className: 'row' },
        el('input', {
          type: 'text', value: tag.name, maxLength: 40, 'aria-label': 'Position name',
          onchange: (e) => {
            const label = e.target.value.trim();
            if (!label) { e.target.value = tag.name; return; }
            change(() => { state.tags.find((t) => t.id === tag.id).name = label; });
          },
        }),
        button('Delete', () => {
          if (used && !confirm(`${used} ${used === 1 ? 'person has' : 'people have'} the "${tag.name}" position. Delete it anyway?`)) return;
          change(() => {
            state.tags = state.tags.filter((t) => t.id !== tag.id);
            for (const p of state.people) if (p.tagId === tag.id) p.tagId = null;
          }, 'Position deleted.');
          positionsDialog();
        }, { className: 'danger' })),
      colorPicker(tag.color, (c) => change(() => { state.tags.find((t) => t.id === tag.id).color = c; })),
      requiredBox(tag.required, {
        onchange: (e) => change(() => { state.tags.find((t) => t.id === tag.id).required = e.target.checked; }),
      }).row,
    );
  });

  openDialog('Positions',
    el('p', { className: 'hint' }, 'Each position has a color that fills its shifts on the schedule. '
      + 'Mark a position as required to be warned when nobody in it is there for the first start or the last end of a day.'),
    el('div', { className: 'list' }, items.length ? items : el('p', {}, 'No positions yet. Add one below.')),
    el('form', { className: 'item', onsubmit: add },
      el('div', { className: 'row' }, name, el('button', { type: 'submit', className: 'primary' }, 'Add')),
      colorPicker(color, (c) => { color = c; }),
      required.row),
    el('div', { className: 'actions' }, button('Done', closeDialog)),
  );
}

function holidaysDialog(year = Number(week.slice(0, 4))) {
  const setHoliday = (date, name) => { state.holidayEdits = logic.setHoliday(state.holidayEdits, date, name); };

  const items = logic.holidaysForYear(year, state.holidayEdits).map(({ date, name }) => el('div', { className: 'item' },
    el('input', {
      type: 'text', value: name, maxLength: 60, 'aria-label': 'Holiday name',
      onchange: (e) => {
        const label = e.target.value.trim();
        if (!label) { e.target.value = name; return; }
        change(() => setHoliday(date, label));
        holidaysDialog(year);
      },
    }),
    el('div', { className: 'row' },
      el('input', {
        type: 'date', value: date, 'aria-label': `Date of ${name}`,
        onchange: (e) => {
          const next = e.target.value;
          if (!logic.isISODate(next) || next === date) return;
          if (logic.holidayName(next, state.holidayEdits) !== null) { toast('There is already a holiday on that date.'); e.target.value = date; return; }
          change(() => { setHoliday(date, null); setHoliday(next, name); }, `${name} moved.`);
          holidaysDialog(Number(next.slice(0, 4)));
        },
      }),
      el('span', { className: 'hint' }, logic.formatDate(date, { weekday: 'long' })),
      button('Remove', () => {
        change(() => setHoliday(date, null), `${name} removed.`);
        holidaysDialog(year);
      }, { className: 'danger' })),
  ));

  const newName = el('input', { type: 'text', maxLength: 60, placeholder: 'Holiday name', 'aria-label': 'New holiday name', autocomplete: 'off' });
  const newDate = el('input', { type: 'date', 'aria-label': 'New holiday date', min: `${year}-01-01` });
  const add = (event) => {
    event.preventDefault();
    const label = newName.value.trim();
    if (!label) return newName.focus();
    if (!logic.isISODate(newDate.value)) return newDate.focus();
    change(() => setHoliday(newDate.value, label), `${label} added.`);
    holidaysDialog(Number(newDate.value.slice(0, 4)));
  };

  const edited = Object.keys(state.holidayEdits).some((d) => d.startsWith(`${year}-`));
  openDialog('Holidays',
    el('p', { className: 'hint' }, 'Holidays are blacked out. Full-time people get 8 hours for each and 30-hour people get 6. Federal Reserve holidays are filled in for every year.'),
    el('div', { className: 'row' },
      button('‹', () => holidaysDialog(year - 1), { 'aria-label': 'Previous year' }),
      el('h3', {}, String(year)),
      button('›', () => holidaysDialog(year + 1), { 'aria-label': 'Next year' })),
    el('div', { className: 'list' }, items),
    el('form', { className: 'item', onsubmit: add },
      el('strong', {}, 'Add a holiday or closed day'),
      newName,
      el('div', { className: 'row' }, newDate, el('button', { type: 'submit', className: 'primary' }, 'Add'))),
    el('div', { className: 'actions' },
      button('Reset to Federal Reserve list', () => {
        change(() => {
          for (const d of Object.keys(state.holidayEdits)) if (d.startsWith(`${year}-`)) delete state.holidayEdits[d];
        }, `${year} holidays reset.`);
        holidaysDialog(year);
      }, { className: 'left', disabled: !edited }),
      button('Done', closeDialog)),
  );
}

function download(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  el('a', { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function backupDialog() {
  const status = el('p', { className: 'hint' });
  storage.requestPersistence().then((granted) => {
    status.textContent = granted
      ? 'This browser has agreed to keep your data, but clearing browsing data will still erase it.'
      : 'Clearing browsing data will erase your schedules, so keep a recent backup file.';
  });

  const file = el('input', {
    type: 'file', accept: '.json,application/json', hidden: true,
    onchange: async () => {
      const chosen = file.files[0];
      if (!chosen) return;
      let imported;
      try {
        imported = storage.sanitize(JSON.parse(await chosen.text()));
      } catch {
        file.value = '';
        return alert('That file could not be read as a Shift Planner backup. Nothing was changed.');
      }
      const summary = `${imported.people.length} people and ${Object.keys(imported.shifts).length} scheduled days`;
      if (state.people.length && !confirm(`Replace everything here with the backup (${summary})?`)) { file.value = ''; return; }
      locked = false;
      closeDialog();
      showWarning(null);
      change(() => { state = imported; }, `Backup loaded: ${summary}.`);
    },
  });

  openDialog('Backup',
    el('p', {}, 'Your team and schedules are saved in this browser, on this device. A backup file protects them and moves them to another computer.'),
    status,
    el('div', { className: 'row' },
      button('Download backup', () => {
        download(JSON.stringify(state, null, 2), `shift-planner-backup-${logic.todayISO()}.json`, 'application/json');
        storage.markBackup();
        renderBackupNote();
        toast('Backup downloaded. Check your Downloads folder.');
      }, { className: 'primary', disabled: locked }),
      button('Load a backup file…', () => file.click()),
      file),
    el('div', { className: 'actions' }, button('Done', closeDialog)),
  );
}

// ---------- toolbar ----------

const actions = {
  'add-person': () => personDialog(),
  branches: () => branchesDialog(),
  positions: () => positionsDialog(),
  holidays: () => holidaysDialog(),
  backup: () => backupDialog(),
  'prev-week': () => goTo(logic.addDays(week, -7)),
  'next-week': () => goTo(logic.addDays(week, 7)),
  'this-week': () => goTo(logic.todayISO()),
  print: () => window.print(),
  pdf: () => {
    const current = view();
    if (!current.people.length) return toast('Add someone to the schedule first.');
    const slug = current.branch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'branch';
    download(buildPdf(current, week, visibleDates()), `schedule-${slug}-${week}.pdf`, 'application/pdf');
    toast('PDF saved. Check your Downloads folder.');
  },
  'copy-week': () => {
    if (!view().people.length) return toast('Add someone to the schedule first.');
    const previous = logic.addDays(week, -7);
    if (!logic.weekHasShifts(view(), previous)) return toast('Last week has no shifts to copy.');
    if (logic.weekHasShifts(view(), week) && !confirm(`${view().branch.name} already has shifts this week. Replace them with last week's schedule?`)) return;
    const { shifts, skipped } = logic.copyWeek(view(), previous, week);
    const names = skipped.map((d) => logic.formatDate(d, { weekday: 'long' })).join(' and ');
    change(() => { state.shifts = shifts; },
      names ? `Copied. Check ${names}: it was a holiday last week, so nothing was copied there.` : 'Last week copied.');
  },
};

function goTo(date) {
  week = logic.weekStart(date);
  hideToast();
  render();
}

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action) actions[action]();
});
$('#jump').addEventListener('change', (e) => { if (logic.isISODate(e.target.value)) goTo(e.target.value); });
$('#show-sunday').addEventListener('change', (e) => change(() => { state.showSunday = e.target.checked; }));

// If the planner is open in two tabs, keep them in step so one can't overwrite the other.
window.addEventListener('storage', (event) => {
  if (event.key !== null && !storage.isStorageKey(event.key)) return;
  ({ state, warning, locked } = storage.load());
  if (dialog.open) closeDialog();
  hideToast();
  showWarning(warning);
  render();
});

showWarning(warning);
render();
if (state.people.length) storage.requestPersistence();
