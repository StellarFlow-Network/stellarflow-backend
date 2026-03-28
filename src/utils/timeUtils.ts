/**
 * Ensure any Date-like value is stored as UTC with millisecond precision.
 *
 * All JS Date objects represent instants in time in UTC internally, but this
 * helper explicitly builds the UTC form to avoid local timezone artifacts when
 * parsing strings or Date objects.
 */
export function normalizeDateToUTC(value: Date | string | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date value provided: ${value}`);
  }

  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}
