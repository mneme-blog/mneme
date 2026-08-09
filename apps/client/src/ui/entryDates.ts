// Date helpers for the month-separated entry lists (desktop editor pane,
// mobile journal drill-in, calendar timeline). listDate/monthKey used to be
// copy-pasted per screen — comments included.
import { fmtDate } from '../i18n';

/** Compact list date: the year appears only when the entry isn't from the
 *  current year, so recent entries stay clean while older ones aren't ambiguous. */
export function listDate(d: Date): string {
  return d.getFullYear() === new Date().getFullYear()
    ? fmtDate(d, { month: 'short', day: 'numeric' })
    : fmtDate(d, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The month/year a list separator groups by — entries are bucketed by their
 *  (displayed) entry date. */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}`;
}
