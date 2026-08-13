import { parseTimeLiteral } from "../core";
import { CliError } from "./errors";

export function parseCliTime(value: string, fps?: number): number {
  const frames = /^([0-9]+)f$/u.exec(value.trim());
  if (frames !== null) {
    if (fps === undefined) {
      throw new CliError("usage", `Frame time ${value} requires --fps.`);
    }
    if (!Number.isFinite(fps) || fps <= 0 || fps > 1_000) {
      throw new CliError("usage", "--fps must be a finite number greater than 0 and at most 1000.");
    }
    const frame = Number(frames[1]);
    const microseconds = Math.round(frame * 1_000_000 / fps);
    if (!Number.isSafeInteger(frame) || !Number.isSafeInteger(microseconds)) {
      throw new CliError("usage", `Frame time is outside the safe range: ${value}`);
    }
    return microseconds;
  }
  try {
    return parseTimeLiteral(value);
  } catch (error) {
    throw new CliError("usage", error instanceof Error ? error.message : String(error));
  }
}
