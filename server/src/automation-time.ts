import { z } from "zod";

export const timezoneSchema = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "时区无效，请使用 Asia/Shanghai 等 IANA 时区");
export const scheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("adaptive") }).strict(),
  z.object({ type: z.literal("once"), at: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ type: z.literal("interval"), minutes: z.number().int().min(1).max(525600) }).strict(),
  z.object({ type: z.literal("daily"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }).strict(),
]);
export type Schedule = z.infer<typeof scheduleSchema>;
const formatter = (timezone: string) => new Intl.DateTimeFormat("en-CA", {
  timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function localParts(f: Intl.DateTimeFormat, date: Date) {
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export const localDay = (date: Date, timezone: string) => localParts(formatter(timezone), date).day;
export function nextLocalDay(now: Date, timezone: string) {
  const f = formatter(timezone), day = localParts(f, now).day;
  for (let t = Math.floor(now.getTime() / 60000) * 60000 + 60000; t <= now.getTime() + 27 * 3600000; t += 60000)
    if (localParts(f, new Date(t)).day !== day) return new Date(t);
  throw new Error("无法计算下一本地日");
}
/** Daily schedules use real local clock occurrences, including DST transitions. */
export function nextWake(schedule: Schedule, timezone: string, now: Date, idle = 0): Date | null {
  switch (schedule.type) {
    case "once": return new Date(schedule.at);
    case "interval": return new Date(now.getTime() + schedule.minutes * 60000);
    case "adaptive": return new Date(now.getTime() + [1, 2, 4, 6][Math.min(idle, 3)] * 3600000);
    case "daily": {
      const f = formatter(timezone);
      for (let t = Math.floor(now.getTime() / 60000) * 60000 + 60000; t <= now.getTime() + 50 * 3600000; t += 60000)
        if (localParts(f, new Date(t)).time === schedule.time) return new Date(t);
      throw new Error("无法计算下一次每日检查");
    }
  }
}
