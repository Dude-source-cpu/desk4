import { parseIcs, mergeEvents } from '../js/calendar.js';
import { daysFromCivil } from '../js/content.js';

let fails = 0;
const ok = (name, cond, detail='') => { console.log((cond?'ok    ':'FAIL  ')+name+(cond?'':' — '+detail)); if(!cond) fails++; };

const today = daysFromCivil(2026, 8, 17);

// Google-style: all-day event, folded line, escaped comma, yearly birthday.
const ics = [
 'BEGIN:VCALENDAR','VERSION:2.0',
 'BEGIN:VEVENT','SUMMARY:Trip to Lisbon\\, at last','DTSTART;VALUE=DATE:20261225','END:VEVENT',
 'BEGIN:VEVENT','SUMMARY:A very long summary that the exporter has ',
 ' folded onto a second line','DTSTART;VALUE=DATE:20260901','END:VEVENT',
 'BEGIN:VEVENT','SUMMARY:Mum\'s birthday','DTSTART;VALUE=DATE:19600214','RRULE:FREQ=YEARLY','END:VEVENT',
 'BEGIN:VEVENT','SUMMARY:Already gone','DTSTART;VALUE=DATE:20260101','END:VEVENT',
 'BEGIN:VEVENT','SUMMARY:Cancelled thing','DTSTART;VALUE=DATE:20261010','STATUS:CANCELLED','END:VEVENT',
 'BEGIN:VEVENT','SUMMARY:Timed meeting','DTSTART:20260920T140000Z','END:VEVENT',
 'END:VCALENDAR',
].join('\r\n');

const out = parseIcs(ics, today);
const titles = out.map(e => e.title);

ok('drops past events', !titles.includes('Already gone'));
ok('drops cancelled events', !titles.includes('Cancelled thing'));
ok('unescapes commas', titles.includes('Trip to Lisbon, at last'), JSON.stringify(titles));
ok('unfolds continued lines', titles.some(t => t === 'A very long summary that the exporter has folded onto a second line'), JSON.stringify(titles));
ok('handles timed events', out.some(e => e.title === 'Timed meeting' && e.date === '2026-09-20'), JSON.stringify(out));
ok('sorted soonest first', out.map(e=>e.date).join() === [...out.map(e=>e.date)].sort().join(), JSON.stringify(out));

const bday = out.find(e => e.title === "Mum's birthday");
ok('yearly repeat rolls forward past 1960', !!bday && bday.date.startsWith('2027-02-14'), JSON.stringify(bday));

// An all-day date must not shift by a timezone.
ok('all-day date is verbatim', out.find(e=>e.title.startsWith('Trip')).date === '2026-12-25');

// Re-importing must not duplicate.
const first = mergeEvents([], out);
const second = mergeEvents(first.events, out);
ok('re-import adds nothing', second.added === 0 && second.events.length === first.events.length,
   `${second.added} added`);
ok('merge keeps existing entries', mergeEvents([{title:'Mine',date:'2026-09-05'}], out).events.some(e=>e.title==='Mine'));

// CRLF and LF both appear in the wild.
ok('parses LF-only files', parseIcs(ics.replace(/\r\n/g,'\n'), today).length === out.length);

console.log(fails ? `\n${fails} failed` : '\nall calendar checks passed');
process.exit(fails ? 1 : 0);
