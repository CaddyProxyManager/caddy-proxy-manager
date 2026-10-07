/** The schedule editor's presets as cron expressions, and back. Client safe: no Bun here. */

export type SchedulePreset =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "custom"; expression: string };

export function presetExpression(preset: SchedulePreset): string {
  switch (preset.kind) {
    case "hourly":
      return `${preset.minute} * * * *`;
    case "daily":
      return `${preset.minute} ${preset.hour} * * *`;
    case "weekly":
      return `${preset.minute} ${preset.hour} * * ${preset.weekday}`;
    case "custom":
      return preset.expression.trim();
  }
}

const FIELD = /^\d{1,2}$/;

/** The preset an expression was made from, so the editor reopens on it; else custom. */
export function presetOf(expression: string): SchedulePreset {
  const parts = expression.trim().split(/\s+/);
  const custom: SchedulePreset = { kind: "custom", expression: expression.trim() };
  if (parts.length !== 5) return custom;
  const [minute, hour, day, month, weekday] = parts;
  if (!FIELD.test(minute) || Number(minute) > 59 || day !== "*" || month !== "*") return custom;
  if (hour === "*" && weekday === "*") return { kind: "hourly", minute: Number(minute) };
  if (!FIELD.test(hour) || Number(hour) > 23) return custom;
  if (weekday === "*") return { kind: "daily", hour: Number(hour), minute: Number(minute) };
  if (/^[0-6]$/.test(weekday)) {
    return { kind: "weekly", weekday: Number(weekday), hour: Number(hour), minute: Number(minute) };
  }
  return custom;
}
