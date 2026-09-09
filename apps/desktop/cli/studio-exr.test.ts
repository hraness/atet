import { expect, test } from "bun:test";
import fc from "fast-check";
import { inspectStudioExrHeader } from "./studio-exr";

function header(pixelType = 1, flags = 2) {
  const int = (value: number) => { const data = Buffer.alloc(4); data.writeInt32LE(value); return data; };
  const attr = (name: string, type: string, value: Buffer) => Buffer.concat([Buffer.from(`${name}\0${type}\0`), int(value.length), value]);
  const channels = Buffer.concat([...["B", "G", "R"].map(name => Buffer.concat([Buffer.from(`${name}\0`), int(pixelType), int(0), int(1), int(1)])), Buffer.from([0])]);
  return Buffer.concat([int(20_000_630), int(flags), attr("channels", "chlist", channels), attr("dataWindow", "box2i", Buffer.concat([int(0), int(0), int(319), int(179)])), Buffer.from([0])]);
}
test("EXR header exposes actual channel names, precision and data window", () => {
  expect(inspectStudioExrHeader(header())).toEqual({ width: 320, height: 180, channels: ["B", "G", "R"].map(name => ({ name, dataType: "float16" })) });
  expect(inspectStudioExrHeader(header(2)).channels.every(channel => channel.dataType === "float32")).toBe(true);
  expect(() => inspectStudioExrHeader(header(1, 0x1002))).toThrow("single-part");
});
test("every truncated admitted header fails without admitting partial metadata", () => {
  const valid = header();
  fc.assert(fc.property(fc.integer({ min: 0, max: valid.length - 1 }), length => {
    expect(() => inspectStudioExrHeader(valid.subarray(0, length))).toThrow();
  }));
});
