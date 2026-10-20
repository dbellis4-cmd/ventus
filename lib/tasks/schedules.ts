import { validDate, validTimezone } from "./dates";
import { TaskInputError } from "./editor";

const timePattern = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?$/;
export function validTime(value: string): boolean { return timePattern.test(value); }

// Enumerate possible UTC instants using offsets around the requested local day,
// then round-trip every candidate. This never silently resolves gaps or folds.
// Intl supplies IANA rules; neither the machine zone nor Date's local parser is used.
export function possibleInstants(date: string, time: string, timezone: string): string[] {
  if (!validDate(date) || !validTime(time) || !validTimezone(timezone)) return [];
  const local = `${date}T${time.length === 5 ? `${time}:00` : time}`;
  const naive = Date.parse(`${local}Z`);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  function wall(instant: number): string {
    const parts = formatter.formatToParts(new Date(instant));
    const p = (type: string) => parts.find((part) => part.type === type)!.value;
    return `${p("year").padStart(4, "0")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}:${p("second")}`;
  }
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = Math.floor((naive + hours * 3_600_000) / 1000) * 1000;
    offsets.add(Date.parse(`${wall(sample)}Z`) - sample);
  }
  const fraction = local.split(".")[1];
  return [...offsets].map((offset) => naive - offset).filter((instant) => wall(instant) === local.split(".")[0]).map((instant) => {
    const iso = new Date(instant).toISOString();
    return fraction ? `${iso.slice(0, 19)}.${fraction}Z` : `${iso.slice(0, 19)}Z`;
  }).sort();
}

function chooseInstant(date: string, time: string, timezone: string, choice: string): string {
  if (choice && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(choice) || !Number.isFinite(Date.parse(choice)))) throw new TaskInputError("Time selections must include an explicit UTC offset.");
  const candidates = possibleInstants(date, time, timezone);
  if (!candidates.length) throw new TaskInputError(`The time ${time} on ${date} does not exist in ${timezone}. Choose another time.`);
  const chosen = choice && candidates.find((candidate) => Date.parse(candidate) === Date.parse(choice));
  if (chosen) return chosen;
  if (candidates.length > 1) throw new TaskInputError(`Choose an explicit UTC instant for the ambiguous time ${time} on ${date} (${timezone}).`);
  if (choice) throw new TaskInputError("The selected time offset is no longer valid. Choose the time again.");
  return candidates[0];
}

export function makeSchedule(date: string, time: string, endTime: string, timezone: string, startChoice = "", endChoice = "", endDate = date) {
  if (!validDate(date) || date < "0002-01-01" || date > "9998-12-31" || !validTimezone(timezone)) throw new TaskInputError("Enter a valid date and IANA timezone.");
  if (!time) {
    if (endTime || startChoice || endChoice) throw new TaskInputError("Anytime tasks cannot have time instants or an end time.");
    return { date, timezone, start_time: null, starts_at: null, end_date: null, end_time: null, ends_at: null };
  }
  if (!validTime(time) || (endTime && (!validTime(endTime) || !validDate(endDate)))) throw new TaskInputError("Enter valid start and end times.");
  const start = chooseInstant(date, time, timezone, startChoice);
  const end = endTime ? chooseInstant(endDate, endTime, timezone, endChoice) : null;
  if (!endTime && endChoice) throw new TaskInputError("An end instant requires an end time.");
  if (end && Date.parse(end) <= Date.parse(start)) throw new TaskInputError("End time must be after the start time.");
  return { date, timezone, start_time: time, starts_at: start, end_date: end ? endDate : null, end_time: endTime || null, ends_at: end };
}
