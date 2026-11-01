import {isoDate, integer, id} from './validation.mjs';

export const ARCHIVE_FIRST_YEAR = 2026;
export const ARCHIVE_TIME_ZONE = 'Africa/Cairo';
export const ARCHIVE_DEFAULTS = Object.freeze({schedulerEnabled:false, exportEnabled:false,
  cleanupEnabled:false, graceDays:90, utcCron:'17 * * * *'});
const cairo = new Intl.DateTimeFormat('en-CA', {timeZone:ARCHIVE_TIME_ZONE,
  year:'numeric',month:'2-digit',day:'2-digit'});

export function cairoDate(serverTimeMs) {
  integer(serverTimeMs, 0, 8_640_000_000_000_000);
  const parts = Object.fromEntries(cairo.formatToParts(new Date(serverTimeMs)).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function financialYearForDate(date) {
  isoDate(date);
  return Number(date.slice(0,4)) - (date.slice(5) < '09-01' ? 1 : 0);
}
export function annualInterval(year) {
  integer(year, ARCHIVE_FIRST_YEAR, 9998);
  return {startDate:`${year}-09-01`,endDate:`${year+1}-09-01`,timeZone:ARCHIVE_TIME_ZONE};
}
export function eligibleYears(serverTimeMs, firstYear=ARCHIVE_FIRST_YEAR) {
  integer(firstYear, ARCHIVE_FIRST_YEAR, 9998);
  const activeYear=financialYearForDate(cairoDate(serverTimeMs));
  return Array.from({length:Math.max(0,activeYear-firstYear)},(_,i)=>firstYear+i);
}

// Recovery never implies authorization to initiate missed years. The caller must
// persist explicit selections; a periodic trigger may only initiate the latest
// newly due year when there is no unstarted predecessor.
export function selectArchiveYears({serverTimeMs, existing=[], selectedYears=[], administratorSelection=false,
  firstYear=ARCHIVE_FIRST_YEAR}) {
  const due=eligibleYears(serverTimeMs,firstYear), byYear=new Map();
  for(const run of existing) {
    annualInterval(run.year); id(run.runId);
    if(byYear.has(run.year)) throw new Error('duplicate-year-state');
    byYear.set(run.year,run);
  }
  if(!Array.isArray(selectedYears)||new Set(selectedYears).size!==selectedYears.length) throw new Error('invalid-year-selection');
  const selection=[...selectedYears].sort((a,b)=>a-b);
  if(selection.length&&!administratorSelection) throw new Error('administrator-selection-required');
  for(const year of selection) if(!due.includes(year)) throw new Error('year-not-eligible');
  const recover=due.filter(y=>byYear.has(y)&&!['complete','verified'].includes(byYear.get(y).state));
  const unstarted=due.filter(y=>!byYear.has(y));
  const latest=due.at(-1), missed=unstarted.filter(y=>y!==latest);
  const start=selection.length?selection.filter(y=>!byYear.has(y)):(missed.length?[]:unstarted);
  const scheduled=new Set([...recover,...start]);
  for(const year of scheduled) for(const predecessor of due.filter(y=>y<year)) {
    if(!['complete','verified'].includes(byYear.get(predecessor)?.state)&&!scheduled.has(predecessor)) {
      throw new Error('previous-close-required');
    }
  }
  return {years:[...scheduled].sort((a,b)=>a-b), recoveryYears:recover,
    backlogRequiringSelection:missed.filter(y=>!selection.includes(y)), dueYears:due};
}
