import type { calendar_v3 } from "@googleapis/calendar";
import { addDays, validDate, validTimezone } from "@/lib/tasks/dates";
import { makeSchedule } from "@/lib/tasks/schedules";

export type CalendarTask = {
  taskId: string; recurrenceKey: string; title: string; location: string | null;
  date: string; timezone: string; time: string | null; startsAt: string | null;
  endDate: string | null; endTime: string | null; endsAt: string | null;
};
export type MappedEvent = { summary: string; location: string | null; start: calendar_v3.Schema$EventDateTime; end: calendar_v3.Schema$EventDateTime };

export function toGoogleEvent(task: CalendarTask): MappedEvent {
  if (!task.startsAt) return { summary: task.title, location: task.location,
    start: { date: task.date }, end: { date: addDays(task.date, 1) } };
  const end = task.endsAt ?? new Date(Date.parse(task.startsAt) + 60 * 60_000).toISOString();
  return { summary: task.title, location: task.location,
    start: { dateTime: new Date(task.startsAt).toISOString(), timeZone: task.timezone },
    end: { dateTime: new Date(end).toISOString(), timeZone: task.timezone } };
}

function local(instant: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}:${part("second")}` };
}

export function fromGoogleEvent(event: calendar_v3.Schema$Event, current: CalendarTask) {
  if (event.recurrence?.length || event.recurringEventId || event.eventType && event.eventType !== "default" ||
      typeof event.summary !== "string" || !event.summary.trim() || event.summary.length > 240 ||
      event.location && event.location.length > 1000) throw new Error("Unsupported Google event edit");
  const title = event.summary.trim();
  const location = event.location ?? "";
  function accepted(schedule: ReturnType<typeof makeSchedule>) {
    const changed = !mappedEqual(toGoogleEvent(current), toGoogleEvent({ ...current,
      date: schedule.date, timezone: schedule.timezone, time: schedule.start_time,
      startsAt: schedule.starts_at, endDate: schedule.end_date,
      endTime: schedule.end_time, endsAt: schedule.ends_at }));
    const oldSpan = current.endDate ? Date.parse(`${current.endDate}T12:00:00Z`) - Date.parse(`${current.date}T12:00:00Z`) : 0;
    const newSpan = schedule.end_date ? Date.parse(`${schedule.end_date}T12:00:00Z`) - Date.parse(`${schedule.date}T12:00:00Z`) : 0;
    if (changed && (current.recurrenceKey === "once" ? oldSpan !== 0 || newSpan !== 0 : oldSpan !== newSpan)) {
      throw new Error("Unsupported Google event span change");
    }
    return { title, location, schedule };
  }
  if (event.start?.date && event.end?.date && !event.start.dateTime && !event.end.dateTime) {
    if (!validDate(event.start.date) || event.end.date !== addDays(event.start.date, 1)) throw new Error("Only one-day all-day events are supported");
    return accepted(makeSchedule(event.start.date, "", "", current.timezone));
  }
  const start = event.start?.dateTime; const end = event.end?.dateTime;
  const zone = event.start?.timeZone || current.timezone;
  const duration = Date.parse(end ?? "") - Date.parse(start ?? "");
  // Google can retain the synthetic end when a task with no end is moved to that instant.
  const synthetic = !!current.startsAt && !current.endsAt && (duration === 0 || duration === 60 * 60_000);
  if (!start || !end || !validTimezone(zone) || zone !== current.timezone || event.end?.timeZone && event.end.timeZone !== zone ||
      !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || duration <= 0 && !synthetic) {
    throw new Error("Unsupported Google event time");
  }
  const first = local(start, zone); const last = local(end, zone);
  return accepted(makeSchedule(first.date, first.time, synthetic ? "" : last.time, zone,
    start, synthetic ? "" : end, last.date));
}

export function mappedEqual(a: MappedEvent, b: MappedEvent): boolean {
  return a.summary === b.summary && (a.location ?? null) === (b.location ?? null) &&
    a.start.date === b.start.date && a.start.dateTime === b.start.dateTime && a.start.timeZone === b.start.timeZone &&
    a.end.date === b.end.date && a.end.dateTime === b.end.dateTime && a.end.timeZone === b.end.timeZone;
}
