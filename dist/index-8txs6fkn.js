// @bun
// src/code/errors.ts
class SlopcameraCodeError extends Error {
  code;
  details;
  constructor(code, message, details) {
    super(message);
    this.name = "SlopcameraCodeError";
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
  }
}
function slopcameraCodeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function asSlopcameraCodeError(error) {
  if (error instanceof SlopcameraCodeError)
    return error;
  return new SlopcameraCodeError("internal", slopcameraCodeErrorMessage(error));
}

// src/code/sha256.ts
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
var UTF8_ENCODER = new TextEncoder;
function createSha256HexHasher() {
  if (typeof Bun !== "undefined") {
    const hasher2 = new Bun.CryptoHasher("sha256");
    return {
      digestHex: () => hasher2.digest("hex"),
      update: (input) => {
        hasher2.update(input);
      }
    };
  }
  const hasher = sha256.create();
  return {
    digestHex: () => bytesToHex(hasher.digest()),
    update: (input) => {
      hasher.update(typeof input === "string" ? UTF8_ENCODER.encode(input) : input);
    }
  };
}
function sha256Hex(input) {
  const hasher = createSha256HexHasher();
  hasher.update(input);
  return hasher.digestHex();
}

// src/code/json-utf8.ts
function jsonStringUtf8ByteLength(value, maximumBytes = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    return;
  let bytes = 2;
  if (bytes > maximumBytes)
    return;
  for (let index = 0;index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let additional;
    if (codeUnit === 34 || codeUnit === 92 || codeUnit === 8 || codeUnit === 9 || codeUnit === 10 || codeUnit === 12 || codeUnit === 13) {
      additional = 2;
    } else if (codeUnit < 32) {
      additional = 6;
    } else if (codeUnit < 128) {
      additional = 1;
    } else if (codeUnit < 2048) {
      additional = 2;
    } else if (codeUnit >= 55296 && codeUnit <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (next >= 56320 && next <= 57343) {
        additional = 4;
        index += 1;
      } else {
        additional = 6;
      }
    } else if (codeUnit >= 56320 && codeUnit <= 57343) {
      additional = 6;
    } else {
      additional = 3;
    }
    if (additional > maximumBytes - bytes)
      return;
    bytes += additional;
  }
  return bytes;
}
function utf8ByteLength(value, maximumBytes = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    return;
  let bytes = 0;
  for (let index = 0;index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let additional;
    if (codeUnit < 128) {
      additional = 1;
    } else if (codeUnit < 2048) {
      additional = 2;
    } else if (codeUnit >= 55296 && codeUnit <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (next >= 56320 && next <= 57343) {
        additional = 4;
        index += 1;
      } else {
        additional = 3;
      }
    } else {
      additional = 3;
    }
    if (additional > maximumBytes - bytes)
      return;
    bytes += additional;
  }
  return bytes;
}

// src/code/json-snapshot.ts
var DEFAULT_MAXIMUM_DEPTH = 128;
var DEFAULT_MAXIMUM_VALUES = 1e6;
var HASH_BUFFER_CODE_UNITS = 64 * 1024;
function invalidJson(message, details) {
  throw new SlopcameraCodeError("invalid-data", message, details);
}
function positiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    return invalidJson(`${name} must be a positive safe integer.`);
  }
  return value;
}
function enumerableSymbolDescriptor(descriptors) {
  return Object.getOwnPropertySymbols(descriptors).some((symbol) => Reflect.get(descriptors, symbol)?.enumerable === true);
}
function captureJsonStructure(input, name, limits = {}) {
  const maximumDepth = positiveLimit(limits.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH, "JSON structure depth limit");
  const maximumValues = positiveLimit(limits.maximumValues ?? DEFAULT_MAXIMUM_VALUES, "JSON structure value limit");
  const maximumBytes = limits.maximumBytes === undefined ? undefined : positiveLimit(limits.maximumBytes, "JSON structure byte limit");
  const active = new WeakSet;
  const pending = [{ depth: 0, kind: "visit", value: input }];
  let bytes = 0;
  let discoveredValues = 1;
  let root;
  let rootAssigned = false;
  const addBytes = (additional) => {
    if (maximumBytes === undefined)
      return;
    if (additional > maximumBytes - bytes) {
      return invalidJson(`${name} contains more than ${String(maximumBytes)} bytes.`, { actualLowerBound: bytes + additional, maximumBytes });
    }
    bytes += additional;
  };
  const addJsonString = (value) => {
    if (maximumBytes === undefined)
      return;
    const additional = jsonStringUtf8ByteLength(value, maximumBytes - bytes);
    if (additional === undefined) {
      return invalidJson(`${name} contains more than ${String(maximumBytes)} bytes.`, { actualLowerBound: maximumBytes + 1, maximumBytes });
    }
    bytes += additional;
  };
  const discover = (additional) => {
    if (additional > maximumValues - discoveredValues) {
      return invalidJson(`${name} contains more than ${String(maximumValues)} structural values.`, { actualLowerBound: discoveredValues + additional, maximumValues });
    }
    discoveredValues += additional;
  };
  const assign = (assignment, value) => {
    if (assignment === undefined) {
      root = value;
      rootAssigned = true;
      return;
    }
    Object.defineProperty(assignment.target, assignment.key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    });
  };
  try {
    while (pending.length > 0) {
      const frame = pending.pop();
      if (frame === undefined)
        continue;
      if (frame.kind === "exit") {
        active.delete(frame.source);
        continue;
      }
      if (frame.depth > maximumDepth) {
        return invalidJson(`${name} nesting exceeds ${String(maximumDepth)} levels.`, { actual: frame.depth, maximumDepth });
      }
      const value = frame.value;
      if (typeof value === "string") {
        addJsonString(value);
        assign(frame.assignment, value);
        continue;
      }
      if (value === null) {
        addBytes(4);
        assign(frame.assignment, value);
        continue;
      }
      if (typeof value === "boolean") {
        addBytes(value ? 4 : 5);
        assign(frame.assignment, value);
        continue;
      }
      if (typeof value === "number") {
        if (Number.isFinite(value)) {
          addBytes(JSON.stringify(Object.is(value, -0) ? 0 : value).length);
        }
        assign(frame.assignment, value);
        continue;
      }
      if (typeof value !== "object") {
        assign(frame.assignment, value);
        continue;
      }
      const isArray = Array.isArray(value);
      if (!isArray) {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          assign(frame.assignment, value);
          continue;
        }
      }
      if (active.has(value)) {
        return invalidJson(`${name} does not support cyclic plain-container values.`);
      }
      const arrayLength = isArray ? value.length : undefined;
      if (arrayLength !== undefined && arrayLength > maximumValues - discoveredValues) {
        return invalidJson(`${name} contains more than ${String(maximumValues)} structural values.`, { actualLowerBound: discoveredValues + arrayLength, maximumValues });
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.getOwnPropertySymbols(descriptors).some((symbol) => Reflect.get(descriptors, symbol)?.enumerable === true)) {
        return invalidJson(`${name} cannot contain enumerable symbol properties.`);
      }
      const keys = Object.keys(descriptors).filter((key) => descriptors[key]?.enumerable === true);
      const namedArrayKeys = arrayLength === undefined ? [] : keys.filter((key) => {
        const index = Number(key);
        return !(Number.isSafeInteger(index) && index >= 0 && index < arrayLength && String(index) === key);
      });
      if (arrayLength !== undefined) {
        discover(arrayLength);
        discover(namedArrayKeys.length);
        addBytes(2 + Math.max(0, arrayLength - 1));
        for (const key of namedArrayKeys) {
          addJsonString(key);
          addBytes(1);
        }
      } else {
        discover(keys.length);
        addBytes(2 + Math.max(0, keys.length - 1));
        for (const key of keys) {
          addJsonString(key);
          addBytes(1);
        }
      }
      const clone = arrayLength === undefined ? {} : new Array(arrayLength);
      assign(frame.assignment, clone);
      active.add(value);
      pending.push({ kind: "exit", source: value });
      for (let index = keys.length - 1;index >= 0; index -= 1) {
        const key = keys[index];
        if (key === undefined)
          continue;
        const descriptor = descriptors[key];
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          return invalidJson(`${name} properties must be plain data properties.`);
        }
        const numericKey = arrayLength !== undefined && Number.isSafeInteger(Number(key)) && Number(key) >= 0 && Number(key) < arrayLength && String(Number(key)) === key ? Number(key) : key;
        pending.push({
          assignment: { key: numericKey, target: clone },
          depth: frame.depth + 1,
          kind: "visit",
          value: descriptor.value
        });
      }
    }
  } catch (error) {
    if (error instanceof SlopcameraCodeError)
      throw error;
    throw new SlopcameraCodeError("invalid-data", `${name} could not be safely inspected.`, { cause: error instanceof Error ? error.message : String(error) });
  }
  if (!rootAssigned) {
    return invalidJson(`${name} did not contain a capturable value.`);
  }
  return root;
}
function assignValue(assignment, value, setRoot) {
  if (assignment === undefined) {
    setRoot(value);
    return;
  }
  if (Array.isArray(assignment.target)) {
    assignment.target[assignment.key] = value;
  } else {
    Object.defineProperty(assignment.target, assignment.key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    });
  }
}
function scalarJson(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalidJson("JSON snapshots do not support non-finite numbers.");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  return JSON.stringify(value);
}
function captureBoundedJson(input, maximumBytesInput, name, limits = {}, capture) {
  const maximumBytes = positiveLimit(maximumBytesInput, "JSON snapshot byte limit");
  const maximumDepth = positiveLimit(limits.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH, "JSON snapshot depth limit");
  const maximumValues = positiveLimit(limits.maximumValues ?? DEFAULT_MAXIMUM_VALUES, "JSON snapshot value limit");
  const active = new WeakSet;
  const hash = capture.hash ? createSha256HexHasher() : undefined;
  let hashPart = capture.hashPrefix ?? "";
  const flushHash = () => {
    if (hash === undefined || hashPart.length === 0)
      return;
    hash.update(hashPart);
    hashPart = "";
  };
  const captureCanonicalText = capture.captureText;
  const canonicalParts = [];
  let canonicalPart = "";
  const pending = [{ depth: 0, kind: "visit", value: input }];
  let bytes = 0;
  let discoveredValues = 1;
  let root;
  const append = (text, exactBytes = text.length) => {
    if (exactBytes > maximumBytes - bytes) {
      return invalidJson(`${name} contains more than ${String(maximumBytes)} bytes.`, { actualLowerBound: bytes + exactBytes, maximumBytes });
    }
    if (hash !== undefined) {
      hashPart += text;
      if (hashPart.length >= HASH_BUFFER_CODE_UNITS)
        flushHash();
    }
    if (captureCanonicalText) {
      canonicalPart += text;
      if (canonicalPart.length >= 64 * 1024) {
        canonicalParts.push(canonicalPart);
        canonicalPart = "";
      }
    }
    bytes += exactBytes;
  };
  const discover = (additional) => {
    if (additional > maximumValues - discoveredValues) {
      return invalidJson(`${name} contains more than ${String(maximumValues)} JSON values.`, { actualLowerBound: discoveredValues + additional, maximumValues });
    }
    discoveredValues += additional;
  };
  const setRoot = (value) => {
    root = value;
  };
  try {
    while (pending.length > 0) {
      const frame = pending.pop();
      if (frame === undefined)
        break;
      if (frame.kind === "array") {
        if (frame.index === frame.values) {
          append("]");
          active.delete(frame.source);
          if (frame.clone !== undefined)
            Object.freeze(frame.clone);
          continue;
        }
        if (frame.index > 0)
          append(",");
        const descriptor = frame.descriptors[String(frame.index)];
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          return invalidJson(`${name} arrays must contain plain data elements.`);
        }
        pending.push({ ...frame, index: frame.index + 1 });
        pending.push({
          ...frame.clone === undefined ? {} : { assignment: { key: frame.index, target: frame.clone } },
          depth: frame.depth + 1,
          kind: "visit",
          value: descriptor.value
        });
        continue;
      }
      if (frame.kind === "object") {
        if (frame.index === frame.keys.length) {
          append("}");
          active.delete(frame.source);
          if (frame.clone !== undefined)
            Object.freeze(frame.clone);
          continue;
        }
        const key = frame.keys[frame.index];
        if (key === undefined) {
          return invalidJson(`${name} lost an object key during traversal.`);
        }
        if (frame.index > 0)
          append(",");
        const keyBytes = jsonStringUtf8ByteLength(key, maximumBytes - bytes);
        if (keyBytes === undefined) {
          return invalidJson(`${name} contains more than ${String(maximumBytes)} bytes.`, { actualLowerBound: maximumBytes + 1, maximumBytes });
        }
        append(scalarJson(key), keyBytes);
        append(":");
        const descriptor = frame.descriptors[key];
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          return invalidJson(`${name} properties must be plain data properties.`);
        }
        pending.push({ ...frame, index: frame.index + 1 });
        pending.push({
          ...frame.clone === undefined ? {} : { assignment: { key, target: frame.clone } },
          depth: frame.depth + 1,
          kind: "visit",
          value: descriptor.value
        });
        continue;
      }
      if (frame.depth > maximumDepth) {
        return invalidJson(`${name} nesting exceeds ${String(maximumDepth)} levels.`, { actual: frame.depth, maximumDepth });
      }
      const value = frame.value;
      if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        const normalized = typeof value === "number" && Object.is(value, -0) ? 0 : value;
        if (typeof value === "string") {
          const stringBytes = jsonStringUtf8ByteLength(value, maximumBytes - bytes);
          if (stringBytes === undefined) {
            return invalidJson(`${name} contains more than ${String(maximumBytes)} bytes.`, { actualLowerBound: maximumBytes + 1, maximumBytes });
          }
          append(scalarJson(value), stringBytes);
        } else {
          append(scalarJson(value));
        }
        if (capture.captureValue) {
          assignValue(frame.assignment, normalized, setRoot);
        }
        continue;
      }
      if (typeof value !== "object") {
        return invalidJson(`${name} does not support ${typeof value} values.`);
      }
      if (active.has(value)) {
        return invalidJson(`${name} does not support cyclic values.`);
      }
      const arrayLength = Array.isArray(value) ? value.length : undefined;
      if (arrayLength !== undefined && arrayLength > maximumValues - discoveredValues) {
        return invalidJson(`${name} contains more than ${String(maximumValues)} JSON values.`, {
          actualLowerBound: discoveredValues + arrayLength,
          maximumValues
        });
      }
      if (arrayLength !== undefined) {
        const punctuationBytes = 2 + Math.max(0, arrayLength - 1);
        if (punctuationBytes > maximumBytes - bytes) {
          return invalidJson(`${name} contains more than ${String(maximumBytes)} bytes.`, { actualLowerBound: bytes + punctuationBytes, maximumBytes });
        }
      }
      active.add(value);
      if (Array.isArray(value)) {
        const length = arrayLength;
        if (length === undefined) {
          return invalidJson(`${name} lost an array length during traversal.`);
        }
        discoveredValues += length;
        const descriptors2 = Object.getOwnPropertyDescriptors(value);
        if (!capture.ignoreNonIndexArrayProperties) {
          if (enumerableSymbolDescriptor(descriptors2)) {
            return invalidJson(`${name} cannot contain enumerable symbol properties.`);
          }
          const keys2 = Object.keys(descriptors2).filter((key) => descriptors2[key]?.enumerable === true);
          if (keys2.length !== length || keys2.some((key, index) => key !== String(index))) {
            return invalidJson(`${name} arrays must be dense and cannot have named properties.`);
          }
        }
        const clone2 = capture.captureValue ? [] : undefined;
        if (clone2 !== undefined)
          assignValue(frame.assignment, clone2, setRoot);
        append("[");
        pending.push({
          clone: clone2,
          depth: frame.depth,
          descriptors: descriptors2,
          index: 0,
          kind: "array",
          source: value,
          values: length
        });
        continue;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return invalidJson(`${name} accepts only arrays and plain objects.`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (enumerableSymbolDescriptor(descriptors)) {
        return invalidJson(`${name} cannot contain enumerable symbol properties.`);
      }
      const keys = Object.keys(descriptors).filter((key) => descriptors[key]?.enumerable === true).sort();
      discover(keys.length);
      const clone = capture.captureValue ? {} : undefined;
      if (clone !== undefined)
        assignValue(frame.assignment, clone, setRoot);
      append("{");
      pending.push({
        clone,
        depth: frame.depth,
        descriptors,
        index: 0,
        keys,
        kind: "object",
        source: value
      });
    }
  } catch (error) {
    if (error instanceof SlopcameraCodeError)
      throw error;
    throw new SlopcameraCodeError("invalid-data", `${name} could not be safely inspected.`, { cause: error instanceof Error ? error.message : String(error) });
  }
  if (capture.captureValue && root === undefined) {
    return invalidJson(`${name} did not contain a JSON value.`);
  }
  if (captureCanonicalText && canonicalPart.length > 0) {
    canonicalParts.push(canonicalPart);
  }
  flushHash();
  return Object.freeze({
    bytes,
    ...captureCanonicalText ? { canonicalText: canonicalParts.join("") } : {},
    ...hash === undefined ? {} : { sha256: hash.digestHex() },
    ...capture.captureValue ? { value: root } : {},
    values: discoveredValues
  });
}
function createBoundedJsonValueSnapshot(input, maximumBytesInput, name, limits = {}) {
  const captured = captureBoundedJson(input, maximumBytesInput, name, limits, {
    captureText: false,
    captureValue: true,
    hash: false,
    ignoreNonIndexArrayProperties: false
  });
  if (captured.value === undefined) {
    return invalidJson(`${name} did not produce a complete JSON value snapshot.`);
  }
  return captured;
}
function createBoundedJsonSnapshot(input, maximumBytesInput, name, limits = {}) {
  const captured = captureBoundedJson(input, maximumBytesInput, name, limits, {
    captureText: limits.captureCanonicalText === true,
    captureValue: true,
    hash: true,
    ignoreNonIndexArrayProperties: false
  });
  if (captured.sha256 === undefined || captured.value === undefined) {
    return invalidJson(`${name} did not produce a complete JSON snapshot.`);
  }
  return captured;
}
function createBoundedCanonicalJson(input, maximumBytesInput, name, limits = {}) {
  const captured = captureBoundedJson(input, maximumBytesInput, name, limits, {
    captureText: true,
    captureValue: false,
    hash: false,
    ignoreNonIndexArrayProperties: true
  });
  if (captured.canonicalText === undefined) {
    return invalidJson(`${name} did not produce canonical JSON text.`);
  }
  return captured.canonicalText;
}
function createBoundedCanonicalFingerprint(input, maximumBytesInput, name, limits = {}, hashPrefix) {
  const captured = captureBoundedJson(input, maximumBytesInput, name, limits, {
    captureText: false,
    captureValue: false,
    hash: true,
    ignoreNonIndexArrayProperties: true,
    ...hashPrefix === undefined ? {} : { hashPrefix }
  });
  if (captured.sha256 === undefined) {
    return invalidJson(`${name} did not produce a canonical JSON identity.`);
  }
  return Object.freeze({ bytes: captured.bytes, sha256: captured.sha256 });
}
function createBoundedCanonicalSha256(input, maximumBytesInput, name, limits = {}, hashPrefix) {
  return createBoundedCanonicalFingerprint(input, maximumBytesInput, name, limits, hashPrefix).sha256;
}
function deepFreezeJson(value) {
  const active = new WeakSet;
  const completed = new WeakSet;
  const pending = [{ exiting: false, value }];
  try {
    while (pending.length > 0) {
      const item = pending.pop();
      if (item === undefined)
        break;
      const current = item.value;
      if (current === null || typeof current === "boolean" || typeof current === "string") {
        continue;
      }
      if (typeof current === "number") {
        if (!Number.isFinite(current)) {
          return invalidJson("JSON snapshots do not support non-finite numbers.");
        }
        continue;
      }
      if (typeof current !== "object") {
        return invalidJson(`JSON snapshots do not support ${typeof current} values.`);
      }
      if (item.exiting) {
        active.delete(current);
        completed.add(current);
        Object.freeze(current);
        continue;
      }
      if (completed.has(current))
        continue;
      if (active.has(current)) {
        return invalidJson("JSON snapshots do not support cycles.");
      }
      active.add(current);
      pending.push({ exiting: true, value: current });
      if (Array.isArray(current)) {
        const length = current.length;
        const descriptors2 = Object.getOwnPropertyDescriptors(current);
        if (enumerableSymbolDescriptor(descriptors2)) {
          return invalidJson("JSON snapshots cannot contain enumerable symbol properties.");
        }
        const keys2 = Object.keys(descriptors2).filter((key) => descriptors2[key]?.enumerable === true);
        if (keys2.length !== length || keys2.some((key, index) => key !== String(index))) {
          return invalidJson("JSON snapshot arrays must be dense and cannot have named properties.");
        }
        for (let index = length - 1;index >= 0; index -= 1) {
          const descriptor = descriptors2[String(index)];
          if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
            return invalidJson("JSON snapshot arrays must contain plain data elements.");
          }
          pending.push({ exiting: false, value: descriptor.value });
        }
        continue;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        return invalidJson("JSON snapshots accept only arrays and plain objects.");
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (enumerableSymbolDescriptor(descriptors)) {
        return invalidJson("JSON snapshots cannot contain enumerable symbol properties.");
      }
      const keys = Object.keys(descriptors).filter((key) => descriptors[key]?.enumerable === true);
      for (let index = keys.length - 1;index >= 0; index -= 1) {
        const key = keys[index];
        if (key === undefined)
          continue;
        const descriptor = descriptors[key];
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          return invalidJson("JSON snapshot properties must be plain data properties.");
        }
        if (descriptor.value === undefined) {
          return invalidJson(`JSON snapshot property ${key} is undefined.`);
        }
        pending.push({ exiting: false, value: descriptor.value });
      }
    }
  } catch (error) {
    if (error instanceof SlopcameraCodeError)
      throw error;
    throw new SlopcameraCodeError("invalid-data", "JSON snapshot could not be safely inspected.", { cause: error instanceof Error ? error.message : String(error) });
  }
  return value;
}

// src/code/canonical-json.ts
var MAX_CANONICAL_JSON_BYTES = Number.MAX_SAFE_INTEGER;
var MAX_CANONICAL_JSON_DEPTH = Number.MAX_SAFE_INTEGER;
var MAX_CANONICAL_JSON_VALUES = Number.MAX_SAFE_INTEGER;
function compareUtf16Strings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function canonicalLimits(bounds) {
  return {
    maximumDepth: bounds?.maximumDepth ?? MAX_CANONICAL_JSON_DEPTH,
    maximumValues: bounds?.maximumValues ?? MAX_CANONICAL_JSON_VALUES
  };
}
function boundedCanonicalJson(value, bounds) {
  return createBoundedCanonicalJson(value, bounds.maximumBytes, bounds.name ?? "Canonical JSON", canonicalLimits(bounds));
}
function boundedCanonicalJsonSha256(value, bounds, hashPrefix) {
  return createBoundedCanonicalSha256(value, bounds.maximumBytes, bounds.name ?? "Canonical JSON", canonicalLimits(bounds), hashPrefix);
}
function boundedCanonicalJsonFingerprint(value, bounds, hashPrefix) {
  return createBoundedCanonicalFingerprint(value, bounds.maximumBytes, bounds.name ?? "Canonical JSON", canonicalLimits(bounds), hashPrefix);
}
function canonicalJson(value) {
  return boundedCanonicalJson(value, {
    maximumBytes: MAX_CANONICAL_JSON_BYTES
  });
}
function canonicalJsonSha256(value) {
  return boundedCanonicalJsonSha256(value, {
    maximumBytes: MAX_CANONICAL_JSON_BYTES
  });
}
function canonicalJsonSha256Prefixed(prefix, value) {
  return boundedCanonicalJsonSha256(value, { maximumBytes: MAX_CANONICAL_JSON_BYTES }, prefix);
}
function canonicalJsonFingerprint(value, hashPrefix) {
  return boundedCanonicalJsonFingerprint(value, { maximumBytes: MAX_CANONICAL_JSON_BYTES }, hashPrefix);
}

export { SlopcameraCodeError, slopcameraCodeErrorMessage, asSlopcameraCodeError, utf8ByteLength, createSha256HexHasher, sha256Hex, captureJsonStructure, createBoundedJsonValueSnapshot, createBoundedJsonSnapshot, deepFreezeJson, compareUtf16Strings, boundedCanonicalJson, boundedCanonicalJsonSha256, boundedCanonicalJsonFingerprint, canonicalJson, canonicalJsonSha256, canonicalJsonSha256Prefixed, canonicalJsonFingerprint };
