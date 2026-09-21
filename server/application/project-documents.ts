import { parse } from "yaml";
import { dayInTimezone, type ProfileDocument } from "../../shared/schema.js";
export const start = "<!-- project-summary:start -->";
export const end = "<!-- project-summary:end -->";
export function metadata(doc: ProfileDocument) {
  const match = doc.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return {
    data: match ? (parse(match[1]) as Record<string, unknown>) : {},
    body: match ? doc.content.slice(match[0].length) : doc.content,
  };
}
export function summary(doc?: ProfileDocument) {
  if (!doc) return "";
  const body = metadata(doc).body;
  const a = body.indexOf(start),
    b = body.indexOf(end);
  if (
    a < 0 ||
    b < a ||
    body.indexOf(start, a + start.length) >= 0 ||
    body.indexOf(end, b + end.length) >= 0
  )
    throw new Error("Managed summary markers were changed. Restore them before retrying.");
  return body.slice(a + start.length, b).trim();
}
export function dueSlot(now: Date, timezone: string) {
  const date = dayInTimezone(now, timezone);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
  const day =
    hour >= 8
      ? date
      : new Date(Date.parse(`${date}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return `${timezone}:${day}`;
}
