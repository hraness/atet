/** Bounded flat single-part EXR header inspection; actual sample decoding remains FFprobe's job. */
export function inspectStudioExrHeader(bytes: Buffer): {
  readonly width: number; readonly height: number; readonly channels: readonly { readonly name: string; readonly dataType: "uint32" | "float16" | "float32" }[];
} {
  const require = (condition: boolean) => { if (!condition) throw new Error("EXR exceeds the admitted flat single-part header profile."); };
  require(bytes.length >= 16 && bytes.readUInt32LE(0) === 20_000_630 && (bytes.readUInt32LE(4) & 0xff) === 2);
  require((bytes.readUInt32LE(4) & ~0x602) === 0); // Allow tiled/long-name flags; deep and multipart need separate profiles.
  let offset = 8;
  const string = (limit: number) => {
    const end = bytes.indexOf(0, offset);
    require(end >= offset && end < limit && end - offset <= 255);
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end));
    offset = end + 1;
    return value;
  };
  const attributes = new Set<string>();
  let width: number | undefined, height: number | undefined;
  let channels: { name: string; dataType: "uint32" | "float16" | "float32" }[] | undefined;
  while (true) {
    const name = string(bytes.length);
    if (name === "") break;
    require(attributes.size < 256 && !attributes.has(name)); attributes.add(name);
    const type = string(bytes.length);
    require(offset + 4 <= bytes.length);
    const size = bytes.readUInt32LE(offset); offset += 4;
    const end = offset + size;
    require(end <= bytes.length);
    if (name === "dataWindow") {
      require(type === "box2i" && size === 16);
      width = bytes.readInt32LE(offset + 8) - bytes.readInt32LE(offset) + 1;
      height = bytes.readInt32LE(offset + 12) - bytes.readInt32LE(offset + 4) + 1;
      require(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 33_554_432);
    } else if (name === "channels") {
      require(type === "chlist"); channels = [];
      const names = new Set<string>();
      while (true) {
        const channel = string(end);
        if (channel === "") break;
        require(channels.length < 32 && !names.has(channel) && offset + 16 <= end);
        names.add(channel);
        const pixelType = bytes.readInt32LE(offset);
        require(pixelType >= 0 && pixelType <= 2 && bytes.readInt32LE(offset + 8) === 1 && bytes.readInt32LE(offset + 12) === 1);
        channels.push({ name: channel, dataType: (["uint32", "float16", "float32"] as const)[pixelType]! });
        offset += 16;
      }
      require(offset === end && channels.length > 0);
    }
    offset = end;
  }
  require(width !== undefined && height !== undefined && channels !== undefined);
  return { width: width!, height: height!, channels: channels! };
}
