export type CommandFlightPart = "response" | "settlement";

export interface CommandFlight {
  readonly commandId: string;
  readonly responseDone: boolean;
  readonly settlementDone: boolean;
}

export function beginCommandFlight(
  current: CommandFlight | null,
  commandId: string,
): Readonly<{ flight: CommandFlight; started: boolean }> {
  return current === null
    ? {
        flight: {
          commandId,
          responseDone: false,
          settlementDone: false,
        },
        started: true,
      }
    : { flight: current, started: false };
}

export function markCommandFlight(
  current: CommandFlight | null,
  commandId: string,
  part: CommandFlightPart,
): CommandFlight | null {
  if (current === null || current.commandId !== commandId) return current;
  const next = {
    ...current,
    responseDone: current.responseDone || part === "response",
    settlementDone: current.settlementDone || part === "settlement",
  };
  return next.responseDone && next.settlementDone ? null : next;
}
