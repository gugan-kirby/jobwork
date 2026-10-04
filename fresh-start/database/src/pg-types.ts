import { types } from 'pg';

/**
 * A Postgres `date` is a calendar date, not an instant, and must not be given a
 * timezone on the way out.
 *
 * `node-pg` parses OID 1082 into a JS `Date` at **local** midnight. Anything that then
 * serialises it as UTC — `toISOString().slice(0, 10)`, the obvious thing to write —
 * shifts the day backwards at every positive offset. In IST (+05:30) a required-by
 * date of 2026-11-30 comes back as 2026-11-29: a customer's deadline silently moves a
 * day earlier, and every party downstream inherits the wrong date.
 *
 * Postgres already sends `date` as `YYYY-MM-DD`. We keep exactly that string. Doc 05
 * §10's store-and-send-UTC rule is about instants (`timestamptz`), which are untouched
 * here and still arrive as `Date`.
 */
const DATE_OID = 1082;

export function registerPgTypeParsers(): void {
  types.setTypeParser(DATE_OID, (value: string) => value);
}
