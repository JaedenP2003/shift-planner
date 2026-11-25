// A time box she can type into or pick from a list of 15-minute steps.

import { clockLabel, minutesToTime, parseTime, timeToMinutes } from './logic.js';

const STEP = 15;
let nextId = 0;

// `range()` returns [firstMinute, lastMinute] for the list. Typing allows any time.
export function timeField({ label, value, range = () => [6 * 60, 21 * 60], onChange }) {
  const id = `time-${++nextId}`;
  const input = Object.assign(document.createElement('input'), {
    type: 'text', id, autocomplete: 'off', value: clockLabel(value), placeholder: 'e.g. 9:15a',
  });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', `${id}-list`);

  const list = document.createElement('ul');
  list.id = `${id}-list`;
  list.className = 'time-list';
  list.popover = 'manual'; // floats above the dialog instead of being cut off by it
  list.setAttribute('role', 'listbox');

  const labelNode = Object.assign(document.createElement('label'), { htmlFor: id, textContent: label });
  const node = document.createElement('div');
  node.className = 'field';
  node.append(labelNode, input, list);

  let options = [];
  let active = -1;
  let typed = false; // has she typed since the list opened?
  const isOpen = () => list.matches(':popover-open');

  function highlight(index) {
    active = Math.max(0, Math.min(options.length - 1, index));
    options.forEach((option, i) => option.setAttribute('aria-selected', String(i === active)));
    const option = options[active];
    if (!option) return;
    input.setAttribute('aria-activedescendant', option.id);
    list.scrollTop = option.offsetTop - list.clientHeight / 2 + option.offsetHeight / 2;
  }

  // Highlights the first listed time at or after `time`.
  function highlightNear(time) {
    const index = options.findIndex((o) => timeToMinutes(o.dataset.time) >= timeToMinutes(time));
    highlight(index < 0 ? options.length - 1 : index);
  }

  function open() {
    if (isOpen()) return;
    const [first, last] = range();
    options = [];
    for (let m = Math.ceil(first / STEP) * STEP; m <= last; m += STEP) {
      const option = document.createElement('li');
      option.id = `${id}-${m}`;
      option.setAttribute('role', 'option');
      option.dataset.time = minutesToTime(m);
      option.textContent = clockLabel(option.dataset.time);
      option.addEventListener('click', () => choose(option.dataset.time));
      options.push(option);
    }
    if (!options.length) return;
    list.replaceChildren(...options);
    list.showPopover();
    input.setAttribute('aria-expanded', 'true');

    const box = input.getBoundingClientRect();
    const height = Math.min(list.scrollHeight + 2, 220);
    const below = box.bottom + height + 4 <= window.innerHeight;
    Object.assign(list.style, {
      left: `${box.left}px`,
      width: `${box.width}px`,
      top: `${below ? box.bottom + 2 : Math.max(4, box.top - height - 2)}px`,
    });
    highlightNear(parseTime(input.value) ?? minutesToTime(first));
  }

  function close() {
    if (isOpen()) list.hidePopover();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function set(time) {
    input.value = clockLabel(time);
  }

  function choose(time) {
    set(time);
    close();
    onChange?.();
  }

  input.addEventListener('focus', () => { typed = false; input.select(); open(); });
  input.addEventListener('click', open);
  input.addEventListener('input', () => {
    typed = true;
    open();
    const time = parseTime(input.value);
    if (time && isOpen()) highlightNear(time);
    onChange?.();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      typed = false;
      if (isOpen()) highlight(active + (event.key === 'ArrowDown' ? 1 : -1));
      else open();
    } else if (event.key === 'Enter' && isOpen()) {
      // Typed text wins over the highlighted row, so "9:10" stays 9:10.
      event.preventDefault();
      const time = typed ? parseTime(input.value) : options[active]?.dataset.time;
      if (time) choose(time);
      else close();
    } else if (event.key === 'Escape' && isOpen()) {
      event.preventDefault(); // close the list, not the whole dialog
      close();
    }
  });
  input.addEventListener('blur', () => {
    close();
    const time = parseTime(input.value);
    if (time) set(time);
    onChange?.();
  });
  // Keeps the box focused while she clicks or scrolls the list.
  list.addEventListener('mousedown', (event) => event.preventDefault());

  return {
    node,
    set,
    // "HH:MM", or null when blank or unreadable.
    get: () => parseTime(input.value),
    isBlank: () => input.value.trim() === '',
  };
}
