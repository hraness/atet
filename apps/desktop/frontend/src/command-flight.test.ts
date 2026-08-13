import { describe, expect, test } from "bun:test";

import {
  beginCommandFlight,
  markCommandFlight,
  type CommandFlight,
} from "./command-flight";

describe("renderer command flight", () => {
  test("suppresses double-clicks and next actions until response and settlement both arrive", () => {
    const first = beginCommandFlight(null, "command_first0001");
    expect(first.started).toBeTrue();
    const suppressed = beginCommandFlight(
      first.flight,
      "command_second001",
    );
    expect(suppressed).toEqual({
      flight: first.flight,
      started: false,
    });

    const responseOnly = markCommandFlight(
      first.flight,
      first.flight.commandId,
      "response",
    );
    expect(responseOnly).toMatchObject({
      responseDone: true,
      settlementDone: false,
    });
    expect(beginCommandFlight(
      responseOnly,
      "command_second001",
    ).started).toBeFalse();
    expect(markCommandFlight(
      responseOnly,
      first.flight.commandId,
      "settlement",
    )).toBeNull();
  });

  test("accepts either completion order and ignores unrelated settlements", () => {
    const flight: CommandFlight = {
      commandId: "command_active001",
      responseDone: false,
      settlementDone: false,
    };
    expect(markCommandFlight(
      flight,
      "command_unrelated1",
      "settlement",
    )).toBe(flight);
    const settlementOnly = markCommandFlight(
      flight,
      flight.commandId,
      "settlement",
    );
    expect(settlementOnly).toMatchObject({
      responseDone: false,
      settlementDone: true,
    });
    expect(markCommandFlight(
      settlementOnly,
      flight.commandId,
      "response",
    )).toBeNull();
  });
});
