// Builds a one-week schedule as a real PDF file, with no outside libraries.
// A PDF is a list of numbered objects; each page has a stream of drawing commands.

import { dayInfo, formatDate, formatHours, mealLabel, shiftLabel, weekLabel, weekSummary } from './logic.js';

const PAGE = { width: 792, height: 612, margin: 30 }; // US Letter, landscape, in points
const NAVY = '#002345';
const ORANGE = '#FF8300';
const LINE = '#C5C5C8';

const rgb = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');

// White or dark text, whichever reads better on the given background.
export function textOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#202021' : '#FFFFFF';
}

// The built-in PDF fonts only cover Western European characters.
function encode(value) {
  return value
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
    .replace(/[\\()]/g, '\\$&');
}

function fit(value, width, size) {
  const max = Math.floor(width / (size * 0.54));
  return value.length <= max ? value : value.slice(0, Math.max(1, max - 2)) + '..';
}

const box = (x, y, w, h, color) => `${rgb(color)} rg ${x} ${PAGE.height - y - h} ${w} ${h} re f`;
const frame = (x, y, w, h) => `${rgb(LINE)} RG 0.5 w ${x} ${PAGE.height - y - h} ${w} ${h} re S`;
const write = (x, y, value, size, color = '#202021', bold = false) =>
  `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${rgb(color)} rg ${x} ${PAGE.height - y} Td (${encode(value)}) Tj ET`;

// Breaks text into lines of at most `max` characters, splitting words only if they are longer.
export function wrap(value, max) {
  const lines = [];
  let line = '';
  for (let word of value.split(' ')) {
    if (line && line.length + 1 + word.length <= max) { line += ` ${word}`; continue; }
    if (line) lines.push(line);
    while (word.length > max) { lines.push(word.slice(0, max)); word = word.slice(max); }
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

export function buildPdf(state, start, dates) {
  const { margin } = PAGE;
  const usable = PAGE.width - margin * 2;
  const nameWidth = 140;
  const totalWidth = 56;
  const dayWidth = (usable - nameWidth - totalWidth) / dates.length;
  const rowHeight = 46;
  const headerBottom = 104;
  const notes = dates.map((date) => wrap(state.notes?.[date] ?? '', Math.floor((dayWidth - 10) / 4.1)));
  const noteLines = Math.max(0, ...notes.map((lines) => lines.length));
  const notesHeight = noteLines ? noteLines * 10 + 10 : 0; // no row when the week has no notes
  const top = headerBottom + notesHeight;
  const perPage = Math.floor((PAGE.height - margin - top) / rowHeight);

  const pages = [];
  const count = Math.max(1, Math.ceil(state.people.length / perPage));
  for (let page = 0; page < count; page++) {
    const out = [
      box(margin, margin, usable, 40, NAVY),
      box(margin, margin + 40, usable, 4, ORANGE),
      write(margin + 12, margin + 26, fit(`${state.branch?.name ?? 'Team'} Schedule`, 480, 18), 18, '#FFFFFF', true),
      write(PAGE.width - margin - 190, margin + 25, weekLabel(start), 12, '#FFFFFF'),
      box(margin, headerBottom - 22, usable, 22, '#DFE6EC'),
      write(margin + 6, headerBottom - 8, 'Team member', 9, NAVY, true),
      write(margin + usable - totalWidth + 8, headerBottom - 8, 'Hours', 9, NAVY, true),
    ];
    dates.forEach((date, i) => {
      const label = formatDate(date, { weekday: 'short', month: 'numeric', day: 'numeric' });
      out.push(write(margin + nameWidth + i * dayWidth + 6, headerBottom - 8, label, 9, NAVY, true));
    });

    if (notesHeight) {
      out.push(frame(margin, headerBottom, nameWidth, notesHeight));
      out.push(write(margin + 6, headerBottom + 13, 'Schedule Notes', 9, NAVY, true));
      notes.forEach((lines, i) => {
        const x = margin + nameWidth + i * dayWidth;
        out.push(frame(x, headerBottom, dayWidth, notesHeight));
        lines.forEach((line, n) => out.push(write(x + 5, headerBottom + 13 + n * 10, line, 7.5)));
      });
      out.push(frame(margin + usable - totalWidth, headerBottom, totalWidth, notesHeight));
    }

    state.people.slice(page * perPage, (page + 1) * perPage).forEach((person, row) => {
      const y = top + row * rowHeight;
      const tag = state.tags.find((t) => t.id === person.tagId);
      const color = tag?.color ?? '#73859F';
      out.push(frame(margin, y, nameWidth, rowHeight));
      out.push(box(margin + 1, y + 1, 4, rowHeight - 2, color));
      out.push(write(margin + 10, y + 17, fit(person.name, nameWidth - 14, 10), 10, '#202021', true));
      if (tag) out.push(write(margin + 10, y + 30, fit(tag.name, nameWidth - 14, 8), 8, '#404040'));

      dates.forEach((date, i) => {
        const x = margin + nameWidth + i * dayWidth;
        const info = dayInfo(state, person, date);
        out.push(frame(x, y, dayWidth, rowHeight));
        if (info.type === 'off') return;
        const fill = info.type === 'holiday' ? '#000000' : color;
        const ink = textOn(fill);
        const first = info.type === 'holiday' ? info.name : shiftLabel(info.shift);
        const rest = info.type === 'holiday'
          ? [info.minutes ? `Holiday - ${formatHours(info.minutes)} h` : 'Closed']
          : [mealLabel(info.shift), `${formatHours(info.minutes)} h`].filter(Boolean);
        out.push(box(x + 2, y + 2, dayWidth - 4, rowHeight - 4, fill));
        out.push(write(x + 6, y + 16, fit(first, dayWidth - 10, 9), 9, ink, true));
        rest.forEach((line, n) => out.push(write(x + 6, y + 28 + n * 11, fit(line, dayWidth - 10, 7.5), 7.5, ink)));
      });

      // The total covers the whole week, even if Sunday is hidden.
      const { minutes } = weekSummary(state, person, start);
      const x = margin + usable - totalWidth;
      out.push(frame(x, y, totalWidth, rowHeight));
      out.push(write(x + 8, y + 23, formatHours(minutes), 12, NAVY, true));
    });

    if (count > 1) out.push(write(PAGE.width - margin - 60, PAGE.height - 14, `Page ${page + 1} of ${count}`, 8));
    pages.push(out.join('\n'));
  }
  return assemble(pages);
}

// Objects 1-4 are fixed; each page then adds a page object and its content stream.
function assemble(pages) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];
  pages.forEach((content, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  // Every character is a single byte, so string positions above equal byte positions.
  return Uint8Array.from(pdf, (c) => c.charCodeAt(0));
}
