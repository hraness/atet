const TIME_TOKEN = /(?:([0-9]+(?:\.[0-9]+)?)(ms|us|h|m|s))/gyu;

function exactIntegerMicroseconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Time literal must resolve to a non-negative, safe integer number of microseconds.");
  }
  return value;
}

export function parseTimeLiteral(input: string): number {
  const value = input.trim();
  if (value.length === 0) throw new Error("Time literal cannot be empty.");

  const clock = /^(?:(\d+):)?([0-5]?\d):([0-5]?\d)(?:\.(\d{1,6}))?$/u.exec(value);
  if (clock !== null) {
    const hours = Number(clock[1] ?? "0");
    const minutes = Number(clock[2]);
    const seconds = Number(clock[3]);
    const fractionUs = Number((clock[4] ?? "").padEnd(6, "0"));
    return exactIntegerMicroseconds((((hours * 60 + minutes) * 60 + seconds) * 1_000_000) + fractionUs);
  }

  let cursor = 0;
  let totalUs = 0;
  let matched = false;
  TIME_TOKEN.lastIndex = 0;
  while (cursor < value.length) {
    TIME_TOKEN.lastIndex = cursor;
    const match = TIME_TOKEN.exec(value);
    if (match === null || match.index !== cursor) {
      throw new Error(`Invalid time literal at offset ${cursor}: ${input}`);
    }
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2];
    const multiplier = unit === "h"
      ? 3_600_000_000
      : unit === "m"
        ? 60_000_000
        : unit === "s"
          ? 1_000_000
          : unit === "ms"
            ? 1_000
            : 1;
    totalUs += amount * multiplier;
    cursor = TIME_TOKEN.lastIndex;
  }
  if (!matched) throw new Error(`Invalid time literal: ${input}`);
  return exactIntegerMicroseconds(totalUs);
}

export function formatTimeLiteral(timeUs: number): string {
  exactIntegerMicroseconds(timeUs);
  const hours = Math.floor(timeUs / 3_600_000_000);
  const minutes = Math.floor((timeUs % 3_600_000_000) / 60_000_000);
  const seconds = Math.floor((timeUs % 60_000_000) / 1_000_000);
  const fraction = timeUs % 1_000_000;
  const prefix = hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}` : String(minutes);
  const suffix = fraction === 0 ? "" : `.${String(fraction).padStart(6, "0").replace(/0+$/u, "")}`;
  return `${prefix}:${String(seconds).padStart(2, "0")}${suffix}`;
}
