import { expect, test } from "bun:test";

import {
  DesktopEventSchema,
  TRANSMUTE_DESKTOP_PROTOCOL_VERSION,
} from "../../contracts";
import {
  encodeHostEvent,
  encodeHostResponse,
  hostSuccess,
  parseHostRequest,
} from "./host-protocol";

test("host protocol accepts only the two recorder commands", () => {
  expect(parseHostRequest({
    command: "transmute.runtime.snapshot",
    id: "bridge-1",
    payload: {},
  }).command).toBe("transmute.runtime.snapshot");
  expect(() => parseHostRequest({
    command: "native-sdk.dialog.openFile",
    id: "bridge-2",
    payload: {},
  })).toThrow();
});

test("host responses and renderer events stay strict bounded JSONL", () => {
  const event = DesktopEventSchema.parse({
    commandId: "command_fixture001",
    kind: "command-settled",
    protocolVersion: TRANSMUTE_DESKTOP_PROTOCOL_VERSION,
    status: "succeeded",
  });
  expect(JSON.parse(encodeHostResponse(hostSuccess("bridge-1", { value: true }))))
    .toEqual({ id: "bridge-1", ok: true, result: { value: true } });
  expect(JSON.parse(encodeHostEvent(event))).toEqual(event);
  expect(() => encodeHostEvent({ ...event, extra: true })).toThrow();
});
