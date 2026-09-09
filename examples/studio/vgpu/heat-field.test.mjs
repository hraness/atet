import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { annotate, energySplit, ENERGY, frameSchedule, rejectAmbientGpuOverrides, tagSrgbPng, validateOptions, verifyCalibration, verifyMetalHardware } from './heat-field.mjs';

test('import stays inert and absolute frame clocks preserve a nonzero interval', () => {
  const frames = frameSchedule(23, 3);
  assert.deepEqual(frames.map(({ index, absoluteFrame, timeNumerator, timeDenominator }) => [index, absoluteFrame, timeNumerator, timeDenominator]), [[0,23,23,24],[1,24,24,24],[2,25,25,24]]);
  assert.equal(frames[1].timeSeconds, 1);
  assert.throws(() => frameSchedule(0, 0));
  assert.throws(() => frameSchedule(-1, 1));
  assert.throws(() => frameSchedule(0, 241));
});

test('every ambient vgpu override is rejected without printing its value', () => {
  for (const name of ['VGPU_ADAPTER', 'VGPU_DAWN_BINARY', 'VGPU_DAWN_FLAGS', 'VGPU_VALIDATE', 'VGPU_FUTURE_OVERRIDE', 'NODE_OPTIONS', 'NODE_PATH']) {
    assert.throws(() => rejectAmbientGpuOverrides({ [name]: 'DO-NOT-PRINT' }), (error) => error.message.includes(name) && !error.message.includes('DO-NOT-PRINT'));
  }
  rejectAmbientGpuOverrides({ PATH: '/usr/bin', SOME_UNRELATED_SETTING: 'x' });
});

test('bounded profile refuses ambiguous dimensions, paths and parameters', () => {
  const valid = { runtimeRoot: '/runtime', outputRoot: '/output' };
  assert.equal(validateOptions(valid).frames, 96);
  for (const patch of [{ runtimeRoot: './relative' }, { frames: 241 }, { frames: NaN }, { width: 767 }, { height: 4096 }, { startFrame: 0.5 }, { shader: 'untrusted' }]) assert.throws(() => validateOptions({ ...valid, ...patch }));
});

test('hardware evidence requires native vendor/device, Metal and explicit non-fallback status', () => {
  const adapter = { name: 'Metal driver', type: 'gpu' };
  const hardware = { vendor: 'apple', device: 'apple-m4-max', architecture: 'metal-3', description: 'Metal driver', isFallbackAdapter: false };
  assert.equal(verifyMetalHardware(adapter, hardware).device, 'apple-m4-max');
  for (const changed of [{ ...hardware, isFallbackAdapter: true }, { ...hardware, isFallbackAdapter: undefined }, { ...hardware, vendor: '', device: '' }, { ...hardware, architecture: 'vulkan', description: 'Vulkan driver' }]) assert.throws(() => verifyMetalHardware(adapter, changed));
  assert.throws(() => verifyMetalHardware({ ...adapter, type: 'cpu' }, hardware));
});

test('illustrative split conserves energy and reflection applies only to unblocked input', () => {
  const split = energySplit(ENERGY);
  assert.equal(split.blocked, 62);
  assert.ok(Math.abs(split.reflected - 6.84) < 1e-10);
  assert.ok(Math.abs(split.absorbed - 31.16) < 1e-10);
  assert.equal(split.blocked + split.reflected + split.absorbed, split.incident);
  assert.equal(energySplit({ incident: 820, shadedFraction: 1, reflectance: 1 }).absorbed, 0);
  assert.throws(() => energySplit({ incident: -1, shadedFraction: 0, reflectance: 0 }));
});

test('calibration detects row orientation, channel order and transfer mismatch', () => {
  const width = 8, height = 8;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(y < 4 ? x < 4 ? [255,0,0,255] : [0,255,0,255] : x < 4 ? [0,0,255,255] : [128,128,128,255], (y * width + x) * 4);
  assert.equal(verifyCalibration(data, width, height).origin, 'top-left');
  for (const [offset, value] of [[(1 * width + 1) * 4, 0], [((height - 2) * width + width - 2) * 4, 55]]) {
    const changed = data.slice(); changed[offset] = value;
    assert.throws(() => verifyCalibration(changed, width, height));
  }
});

test('authored labels fit both bounds and preserve opaque alpha', () => {
  for (const [width, height] of [[384,216], [768,432], [1024,576]]) {
    const data = new Uint8Array(width * height * 4).fill(255);
    const result = annotate(data, width, height, frameSchedule(100000, 1)[0]);
    assert.equal(result.length, data.length);
    assert.ok(result.some((value) => value !== 255));
    for (let index = 3; index < result.length; index += 4) assert.equal(result[index], 255);
  }
});

test('PNG sRGB tag declares the exact transfer with a valid chunk CRC', () => {
  const header = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header);
  header.write('IHDR', 12);
  const tagged = tagSrgbPng(header);
  assert.equal(tagged.readUInt32BE(33), 1);
  assert.equal(tagged.subarray(37, 41).toString(), 'sRGB');
  assert.equal(tagged[41], 0);
  assert.equal(tagged.readUInt32BE(42), crc32(tagged.subarray(37, 42)));
});
