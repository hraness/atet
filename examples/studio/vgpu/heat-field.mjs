import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { createRequire } from 'node:module';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FPS = Object.freeze({ numerator: 24, denominator: 1 });
export const ENERGY = Object.freeze({ incident: 100, shadedFraction: 0.62, reflectance: 0.18 });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function validateOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected render options');
  const allowed = new Set(['runtimeRoot', 'outputRoot', 'width', 'height', 'frames', 'startFrame']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('Unknown render option');
  for (const key of ['runtimeRoot', 'outputRoot']) if (typeof input[key] !== 'string' || !isAbsolute(input[key])) throw new Error(`${key} must be absolute`);
  const value = { ...input, width: input.width ?? 768, height: input.height ?? 432, frames: input.frames ?? 96, startFrame: input.startFrame ?? 0 };
  for (const [key, min, max] of [['width', 384, 1024], ['height', 216, 1024], ['frames', 1, 240], ['startFrame', 0, 100000]]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) throw new Error(`${key} is outside the bounded profile`);
  }
  if (value.width * 9 !== value.height * 16) throw new Error('The authored graphic requires a 16:9 frame');
  return Object.freeze(value);
}

export function rejectAmbientGpuOverrides(env) {
  const names = Object.keys(env).filter((name) => /^(VGPU_|NODE_OPTIONS$|NODE_PATH$)/u.test(name));
  if (names.length) throw new Error(`Remove ambient runtime overrides: ${names.sort().join(', ')}`);
}

export function verifyMetalHardware(adapter, hardware) {
  if (adapter?.type !== 'gpu' || hardware?.isFallbackAdapter !== false || !hardware.vendor || !hardware.device
    || !/apple|amd|radeon|intel|nvidia/iu.test(`${hardware.vendor} ${hardware.device}`)
    || !/metal/iu.test(`${hardware.architecture} ${hardware.description}`)) throw new Error('No identifiable non-fallback Metal hardware observed');
  return { ...Object.fromEntries(['vendor', 'architecture', 'device', 'description', 'backend', 'backendType'].flatMap((key) => typeof hardware[key] === 'string' ? [[key, hardware[key].slice(0, 256)]] : [])), isFallbackAdapter: false };
}

export function frameSchedule(startFrame, frames) {
  if (!Number.isSafeInteger(startFrame) || startFrame < 0 || startFrame > 100000 || !Number.isSafeInteger(frames) || frames < 1 || frames > 240) throw new Error('Invalid frame interval');
  return Array.from({ length: frames }, (_, index) => ({ index, absoluteFrame: startFrame + index, timeNumerator: startFrame + index, timeDenominator: FPS.numerator, timeSeconds: (startFrame + index) / FPS.numerator }));
}

export function energySplit({ incident, shadedFraction, reflectance }) {
  if (![incident, shadedFraction, reflectance].every(Number.isFinite) || incident <= 0 || incident > 10000 || shadedFraction < 0 || shadedFraction > 1 || reflectance < 0 || reflectance > 1) throw new Error('Invalid illustrative energy split');
  const blocked = incident * shadedFraction;
  const reflected = (incident - blocked) * reflectance;
  const absorbed = incident - blocked - reflected;
  return Object.freeze({ incident, blocked, reflected, absorbed });
}

const COLOR_FUNCTIONS = `
fn linear(c: vec3f) -> vec3f { return select(c / 12.92, pow((c + 0.055) / 1.055, vec3f(2.4)), c > vec3f(0.04045)); }
fn srgb(c: vec3f) -> vec3f { let x = clamp(c, vec3f(0), vec3f(1)); return select(x * 12.92, 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x > vec3f(0.0031308)); }
`;

export const CALIBRATION_WGSL = `${COLOR_FUNCTIONS}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var c = vec3f(1, 0, 0);
  if (uv.x >= 0.5 && uv.y < 0.5) { c = vec3f(0, 1, 0); }
  if (uv.x < 0.5 && uv.y >= 0.5) { c = vec3f(0, 0, 1); }
  if (uv.x >= 0.5 && uv.y >= 0.5) { c = linear(vec3f(128.0 / 255.0)); }
  return vec4f(srgb(c), 1);
}`;

export const HEAT_FIELD_WGSL = `${COLOR_FUNCTIONS}
struct Params { time: f32, blocked: f32, reflected: f32, absorbed: f32 }
@group(0) @binding(0) var<uniform> params: Params;
fn line(p: vec2f, a: vec2f, b: vec2f, thickness: f32) -> f32 {
  let delta = b - a;
  let d = length(p - a - delta * clamp(dot(p - a, delta) / dot(delta, delta), 0.0, 1.0));
  return 1.0 - smoothstep(thickness, thickness + 0.0015, d);
}
fn rect(p: vec2f, lo: vec2f, hi: vec2f, radius: f32) -> f32 {
  let q = abs(p - (lo + hi) * 0.5) - (hi - lo) * 0.5 + radius;
  let d = length(max(q, vec2f(0))) + min(max(q.x, q.y), 0.0) - radius;
  return 1.0 - smoothstep(-0.001, 0.001, d);
}
@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv;
  let amber = linear(vec3f(1.0, 0.68, 0.24));
  let cyan = linear(vec3f(0.28, 0.87, 0.87));
  let purple = linear(vec3f(0.67, 0.57, 0.95));
  var c = linear(vec3f(0.027, 0.055, 0.085));
  c += linear(vec3f(0.035, 0.075, 0.09)) * exp(-4.0 * length((p - vec2f(0.48, 0.5)) * vec2f(1, 1.7)));
  let card = rect(p, vec2f(0.035, 0.22), vec2f(0.695, 0.79), 0.014);
  c = mix(c, linear(vec3f(0.05, 0.093, 0.12)), card);
  let grid = max(1.0 - smoothstep(0.0, 0.001, abs(fract(p.x * 28.0) - 0.5) / 28.0), 1.0 - smoothstep(0.0, 0.001, abs(fract(p.y * 18.0) - 0.5) / 18.0));
  c += linear(vec3f(0.065, 0.1, 0.12)) * grid * card * 0.28;
  let sun = vec2f(0.122, 0.365);
  c += amber * 0.08 * exp(-30.0 * length((p - sun) * vec2f(1, 0.5625)));
  c = mix(c, amber, 1.0 - smoothstep(0.025, 0.027, length((p - sun) * vec2f(1, 0.5625))));
  // Rays carry a periodic pulse; the energy split remains fixed and illustrative.
  for (var i = 0; i < 5; i += 1) {
    let start = vec2f(0.18, 0.30 + f32(i) * 0.064);
    let finish = vec2f(0.60, 0.49 + f32(i) * 0.048);
    let ray = line(p, start, finish, 0.0012);
    let pulse = pow(0.5 + 0.5 * cos((p.x - params.time * 0.14 + f32(i) * 0.016) * 60.0), 12.0);
    c = mix(c, amber, ray * (0.30 + 0.65 * pulse));
  }
  let wall = rect(p, vec2f(0.53, 0.38), vec2f(0.645, 0.72), 0.003);
  c = mix(c, linear(vec3f(0.25, 0.34, 0.36)), wall);
  let glass = rect(p, vec2f(0.543, 0.405), vec2f(0.632, 0.682), 0.001);
  let heat = smoothstep(0.49, 0.68, p.y) * (0.70 + 0.08 * sin(params.time * 2.0 + p.y * 26.0 + p.x * 19.0));
  c = mix(c, mix(linear(vec3f(0.08, 0.25, 0.31)), amber * 0.32, heat), glass);
  c = mix(c, cyan * 0.55, line(p, vec2f(0.587, 0.405), vec2f(0.587, 0.682), 0.001));
  c = mix(c, cyan * 0.30, line(p, vec2f(0.543, 0.545), vec2f(0.632, 0.545), 0.001));
  // A canopy and its qualitative shade are separate from the numeric data model.
  c = mix(c, linear(vec3f(0.13, 0.27, 0.31)), rect(p, vec2f(0.45, 0.355), vec2f(0.65, 0.388), 0.003));
  c = mix(c, cyan, line(p, vec2f(0.45, 0.357), vec2f(0.65, 0.357), 0.0014));
  c = mix(c, cyan * 0.65, line(p, vec2f(0.41, 0.72), vec2f(0.667, 0.72), 0.001));
  c = mix(c, purple, line(p, vec2f(0.545, 0.60), vec2f(0.454, 0.65), 0.0013) * (0.55 + 0.4 * sin(params.time * 4.0) * sin(params.time * 4.0)));
  c = mix(c, purple, line(p, vec2f(0.454, 0.65), vec2f(0.47, 0.631), 0.0013));
  c = mix(c, purple, line(p, vec2f(0.454, 0.65), vec2f(0.477, 0.648), 0.0013));
  let quantities = array<f32, 3>(params.blocked, params.reflected, params.absorbed);
  let colors = array<vec3f, 3>(cyan, purple, amber);
  for (var row = 0; row < 3; row += 1) {
    let y = 0.38 + f32(row) * 0.148;
    c = mix(c, linear(vec3f(0.12, 0.17, 0.20)), rect(p, vec2f(0.735, y), vec2f(0.957, y + 0.017), 0.003));
    c = mix(c, colors[row], rect(p, vec2f(0.735, y), vec2f(0.735 + 0.222 * quantities[row], y + 0.017), 0.003));
  }
  c = mix(c, linear(vec3f(0.12, 0.2, 0.24)), line(p, vec2f(0.035, 0.848), vec2f(0.962, 0.848), 0.0007));
  return vec4f(srgb(c), 1);
}`;

// Original 5×7 bitmap lettering keeps this optional example font- and browser-free.
const GLYPHS = {
  A:'01110100011000111111100011000110001', B:'11110100011000111110100011000111110', C:'01111100001000010000100001000001111', D:'11110100011000110001100011000111110', E:'11111100001000011110100001000011111', F:'11111100001000011110100001000010000', G:'01111100001000010111100011000101111', H:'10001100011000111111100011000110001', I:'11111001000010000100001000010011111', J:'00111000100001000010000101001001100', K:'10001100101010011000101001001010001', L:'10000100001000010000100001000011111', M:'10001110111010110101100011000110001', N:'10001110011010110011100011000110001', O:'01110100011000110001100011000101110', P:'11110100011000111110100001000010000', Q:'01110100011000110001101011001001101', R:'11110100011000111110101001001010001', S:'01111100001000001110000010000111110', T:'11111001000010000100001000010000100', U:'10001100011000110001100011000101110', V:'10001100011000110001100010101000100', W:'10001100011000110101101011101110001', X:'10001100010101000100010101000110001', Y:'10001100010101000100001000010000100', Z:'11111000010001000100010001000011111',
  '0':'01110100011001110101110011000101110', '1':'00100011000010000100001000010001110', '2':'01110100010000100010001000100011111', '3':'11110000010000101110000010000111110', '4':'00010001100101010010111110001000010', '5':'11111100001000011110000010000111110', '6':'01110100001000011110100011000101110', '7':'11111000010001000100010000100001000', '8':'01110100011000101110100011000101110', '9':'01110100011000101111000010000101110', '%':'11001110100001000100010001001110011', '/':'00001000100001000100010000100010000', '.':'00000000000000000000000000011000110', '-':'00000000000000011111000000000000000', ':':'00000011000110000000011000110000000', ' ':'00000000000000000000000000000000000',
};

export function annotate(rgba, width, height, frame) {
  if (!(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) throw new Error('Invalid RGBA raster');
  const unit = width / 768;
  function text(message, x, y, size, color) {
    let cursor = x * unit;
    const scale = size * unit;
    for (const character of message) {
      const bits = GLYPHS[character];
      if (!bits) throw new Error(`Unsupported authored glyph ${character}`);
      for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (bits[gy * 5 + gx] === '1') {
        for (let py = Math.floor(y * unit + gy * scale); py < Math.floor(y * unit + (gy + 1) * scale); py++) for (let px = Math.floor(cursor + gx * scale); px < Math.floor(cursor + (gx + 1) * scale); px++) {
          if (px < 0 || px >= width || py < 0 || py >= height) throw new Error('Authored label exceeds frame');
          rgba.set([...color, 255], (py * width + px) * 4);
        }
      }
      cursor += 6 * scale;
    }
  }
  text('SOLAR ENERGY', 28, 27, 3, [235, 243, 240]);
  text('SHADE / RAY FLOW', 29, 64, 1.5, [126, 162, 176]);
  text('100 UNITS', 557, 28, 2.5, [255, 187, 92]);
  text('NORMALIZED INPUT', 557, 57, 1.4, [126, 162, 176]);
  text('CANOPY', 342, 128, 1.3, [116, 220, 216]);
  text('GLAZING', 377, 319, 1.3, [164, 190, 197]);
  text('62% BLOCKED', 564, 126, 1.5, [106, 223, 219]);
  text('7% REFLECTED', 564, 190, 1.5, [178, 155, 248]);
  text('31% ABSORBED', 564, 254, 1.5, [255, 187, 92]);
  text('ILLUSTRATIVE ENERGY SPLIT', 28, 386, 1.6, [196, 216, 219]);
  text('T ' + frame.timeSeconds.toFixed(2) + ' S', 571, 386, 1.6, [126, 162, 176]);
  return rgba;
}

export function verifyCalibration(bytes, width, height) {
  const expected = [[1, 1, [255, 0, 0, 255]], [width - 2, 1, [0, 255, 0, 255]], [1, height - 2, [0, 0, 255, 255]], [width - 2, height - 2, [128, 128, 128, 255]]];
  if (bytes.length !== width * height * 4) throw new Error('Calibration byte count mismatch');
  for (const [x, y, pixel] of expected) for (let channel = 0; channel < 4; channel++) if (Math.abs(bytes[(y * width + x) * 4 + channel] - pixel[channel]) > 1) throw new Error('GPU orientation or sRGB calibration failed');
  return { origin: 'top-left', channels: 'rgba', alpha: 'opaque', graySrgbByte: 128, toleranceBytes: 1 };
}

export function tagSrgbPng(png) {
  if (png.length < 33 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.subarray(12, 16).toString() !== 'IHDR') throw new Error('Expected an encoded PNG');
  // Standard PNG sRGB chunk: one-byte perceptual intent, with the specified CRC.
  // No approximate gamma exponent replaces the shader's piecewise sRGB transfer.
  return Buffer.concat([png.subarray(0, 33), Buffer.from('000000017352474200aece1ce9', 'hex'), png.subarray(33)]);
}

async function physical(path, type) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !(type === 'directory' ? stat.isDirectory() : stat.isFile()) || await realpath(path) !== path) throw new Error(`Expected physical ${type}: ${path}`);
  return stat;
}

export async function renderHeatField(input) {
  const options = validateOptions(input);
  rejectAmbientGpuOverrides(process.env);
  if (process.platform !== 'darwin') throw new Error('This qualified example requires macOS Metal; qualify another backend separately');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('vgpu requires Node22+');
  await physical(options.runtimeRoot, 'directory');
  await physical(dirname(options.outputRoot), 'directory');
  const runtimeRequire = createRequire(join(options.runtimeRoot, 'package.json'));
  const versions = {};
  for (const [name, expected] of [['vgpu', '0.4.1'], ['@vgpu/adapter-node', '0.4.1'], ['webgpu', '0.4.0'], ['pngjs', '7.0.0']]) {
    const packagePath = join(options.runtimeRoot, 'node_modules', name, 'package.json');
    await physical(packagePath, 'file');
    const value = JSON.parse(await readFile(packagePath, 'utf8'));
    if (value.version !== expected) throw new Error(`Expected ${name}@${expected}`);
    versions[name] = expected;
  }
  const source = await readFile(fileURLToPath(import.meta.url));
  const lock = await readFile(join(options.runtimeRoot, 'package-lock.json'));
  const nativePath = join(options.runtimeRoot, 'node_modules/webgpu/dist/darwin-universal.dawn.node');
  await physical(nativePath, 'file');
  const nativeSha256 = sha256(await readFile(nativePath));
  const nodeSha256 = sha256(await readFile(await realpath(process.execPath)));
  await mkdir(options.outputRoot, { mode: 0o700 });
  await writeFile(join(options.outputRoot, 'heat-field.source.mjs'), source, { flag: 'wx', mode: 0o600 });
  await writeFile(join(options.outputRoot, 'runtime-lock.json'), lock, { flag: 'wx', mode: 0o600 });
  await writeFile(join(options.outputRoot, 'intent.json'), JSON.stringify({ kind: 'atet-vgpu-example-intent', options: { width: options.width, height: options.height, frames: options.frames, startFrame: options.startFrame }, sourceSha256: sha256(source), lockSha256: sha256(lock), execution: 'explicit-trusted-current-user', hermetic: false, status: 'incomplete-until-manifest' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const deadline = setTimeout(() => { process.stderr.write('GPU example exceeded120s; incomplete outputs retained\n'); process.kill(process.pid, 'SIGTERM'); }, 120000);
  deadline.unref();
  let gpu;
  try {
    const { init, effect, target, frame } = await import(pathToFileURL(runtimeRequire.resolve('vgpu/node')).href);
    const { PNG } = runtimeRequire('pngjs');
    gpu = await init({ adapter: 'hardware', backend: 'webgpu', backendFlags: ['backend=metal'] });
    const hardware = gpu.device.adapterInfo;
    const adapterInfo = verifyMetalHardware(gpu.adapter, hardware);
    const errors = [];
    gpu.onError((error) => { errors.push(error); });
    const settle = async () => { await gpu.settled(); if (errors.length) throw new Error('GPU validation failed: ' + errors.map((error) => error.code ?? 'unknown').join(', ')); };
    const output = target(gpu, { size: [options.width, options.height], format: 'rgba8unorm' });
    const calibration = effect(gpu, CALIBRATION_WGSL);
    await calibration.compile(output);
    frame(gpu, (f) => f.pass(output, calibration));
    await settle();
    const calibrationBytes = await output.read();
    await settle();
    const calibrationEvidence = verifyCalibration(calibrationBytes, options.width, options.height);
    const calibrationPng = tagSrgbPng(PNG.sync.write({ width: options.width, height: options.height, data: Buffer.from(calibrationBytes) }, { colorType: 2 }));
    await writeFile(join(options.outputRoot, 'calibration.png'), calibrationPng, { flag: 'wx', mode: 0o600 });
    const energy = energySplit(ENERGY);
    const params = { time: 0, blocked: energy.blocked / energy.incident, reflected: energy.reflected / energy.incident, absorbed: energy.absorbed / energy.incident };
    const graphic = effect(gpu, HEAT_FIELD_WGSL, { set: { params } });
    await graphic.compile(output);
    const frames = [];
    let totalBytes = calibrationPng.length;
    for (const item of frameSchedule(options.startFrame, options.frames)) {
      graphic.set({ params: { ...params, time: item.timeSeconds } });
      frame(gpu, (f) => f.pass(output, graphic));
      await settle();
      const raw = await output.read();
      await settle();
      if (raw.length !== options.width * options.height * 4) throw new Error('RGBA readback size mismatch');
      for (let index = 3; index < raw.length; index += 4) if (raw[index] !== 255) throw new Error('Expected opaque GPU output');
      const rawSha256 = sha256(raw);
      const annotated = annotate(raw.slice(), options.width, options.height, item);
      const png = tagSrgbPng(PNG.sync.write({ width: options.width, height: options.height, data: Buffer.from(annotated) }, { colorType: 2 }));
      totalBytes += png.length;
      if (totalBytes > 128 * 1024 * 1024) throw new Error('Output byte limit exceeded');
      const path = `frame-${String(item.index).padStart(6, '0')}.png`;
      await writeFile(join(options.outputRoot, path), png, { flag: 'wx', mode: 0o600 });
      const retained = await readFile(join(options.outputRoot, path));
      if (sha256(retained) !== sha256(png)) throw new Error('Retained frame changed');
      const decoded = PNG.sync.read(retained);
      if (decoded.width !== options.width || decoded.height !== options.height || !Buffer.from(decoded.data).equals(Buffer.from(annotated))) throw new Error('PNG changed GPU-derived pixels');
      frames.push({ ...item, path, bytes: png.length, sha256: sha256(png), rawGpuRgbaSha256: rawSha256 });
    }
    if (frames.length > 1 && frames.every((entry) => entry.rawGpuRgbaSha256 === frames[0].rawGpuRgbaSha256)) throw new Error('Animation did not change GPU pixels');
    await settle();
    if (sha256(await readFile(nativePath)) !== nativeSha256 || sha256(await readFile(join(options.runtimeRoot, 'package-lock.json'))) !== sha256(lock) || sha256(await readFile(fileURLToPath(import.meta.url))) !== sha256(source)) throw new Error('Source or native runtime changed during rendering');
    const nativeModules = Object.keys(runtimeRequire.cache).filter((path) => path.endsWith('.node'));
    if (nativeModules.length !== 1 || nativeModules[0] !== nativePath) throw new Error('Unexpected loaded native dependency');
    const manifest = { kind: 'atet-vgpu-illustrative-sequence', schemaVersion: 1, execution: 'explicit-trusted-current-user', renderer: 'vgpu-offscreen-effect', sceneOwnership: 'external-existing-renderer', physicalSimulation: false, dimensions: { width: options.width, height: options.height }, fps: FPS, frameInterval: { startInclusive: options.startFrame, endExclusive: options.startFrame + options.frames }, color: { primaries: 'srgb', transfer: 'srgb', channels: 'rgb', dataType: 'uint8', alpha: 'opaque', origin: 'top-left', pngSrgbIntent: 'perceptual' }, energy, inputProvenance: 'authored-illustrative-values-not-measurements', annotations: 'project-owned-original-bitmap-labels-after-GPU-readback', sourceSha256: sha256(source), shaderSha256: sha256(HEAT_FIELD_WGSL), lockSha256: sha256(lock), runtime: { node: process.versions.node, nodeSha256, nativeBinary: 'webgpu/dist/darwin-universal.dawn.node', nativeSha256, platform: process.platform, arch: process.arch, versions }, adapter: gpu.adapter, adapterInfo, backendRequested: 'metal', calibration: { ...calibrationEvidence, path: 'calibration.png', sha256: sha256(calibrationPng) }, totalBytes, frames };
    gpu.dispose();
    gpu = undefined;
    await writeFile(join(options.outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return manifest;
  } finally {
    gpu?.dispose();
    clearTimeout(deadline);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  const names = { '--runtime': 'runtimeRoot', '--output': 'outputRoot', '--width': 'width', '--height': 'height', '--frames': 'frames', '--start-frame': 'startFrame' };
  try {
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = names[process.argv[index]];
      if (!key || options[key] !== undefined || !process.argv[index + 1]) throw new Error('Expected unique --runtime ABS --output ABS [--frames N --start-frame N --width N --height N]');
      options[key] = ['runtimeRoot', 'outputRoot'].includes(key) ? process.argv[index + 1] : Number(process.argv[index + 1]);
    }
    const manifest = await renderHeatField(options);
    process.stdout.write(JSON.stringify({ outputRoot: options.outputRoot, adapter: manifest.adapter, frames: manifest.frames.length, totalBytes: manifest.totalBytes }) + '\n');
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  }
}
