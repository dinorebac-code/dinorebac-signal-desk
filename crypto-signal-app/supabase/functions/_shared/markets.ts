export const WATCH_WINDOW = {
  start: "16:00",
  end: "17:30",
  timezone: "Europe/Oslo",
};

export const MARKETS = [
  {
    code: "SOL",
    label: "SOL",
    symbol: "SOL/USD",
    preferredLongTriggers: ["bullish_engulfing", "hammer", "breakout_retest", "momentum_close"],
    preferredShortTriggers: ["bearish_engulfing", "shooting_star", "breakout_retest"],
    volatilityWeight: 1.2,
  },
  {
    code: "EURUSD",
    label: "EUR/USD",
    symbol: "EUR/USD",
    preferredLongTriggers: ["bullish_engulfing", "breakout_retest", "momentum_close"],
    preferredShortTriggers: ["bearish_engulfing", "shooting_star", "breakout_retest"],
    volatilityWeight: 0.7,
  },
] as const;

export const TRIGGER_LABELS: Record<string, string> = {
  bullish_engulfing: "Bullish engulfing",
  bearish_engulfing: "Bearish engulfing",
  shooting_star: "Shooting star",
  hammer: "Hammer",
  breakout_retest: "Breakout retest",
  momentum_close: "Momentum close",
};

export function getTodayKey(timezone = WATCH_WINDOW.timezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

export function isInsideWatchWindow(timezone = WATCH_WINDOW.timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const currentValue = hour * 60 + minute;
  const [startHour, startMinute] = WATCH_WINDOW.start.split(":").map(Number);
  const [endHour, endMinute] = WATCH_WINDOW.end.split(":").map(Number);
  const startValue = startHour * 60 + startMinute;
  const endValue = endHour * 60 + endMinute;
  return currentValue >= startValue && currentValue <= endValue;
}
