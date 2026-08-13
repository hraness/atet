export const HTML_OVERLAY_RANDOM_ALGORITHM = "studio-html-overlay-random-v1" as const;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const MULBERRY_INCREMENT = 0x6d2b79f5;
const UINT32_RANGE = 4_294_967_296;

function hashRandomDomain(value: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

function nextMulberry32(state: number): readonly [number, number] {
  const nextState = (state + MULBERRY_INCREMENT) >>> 0;
  let value = nextState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return [nextState, ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE];
}

function randomSeed(seed: number, namespace: string): number {
  return hashRandomDomain(`${HTML_OVERLAY_RANDOM_ALGORITHM}\0${seed >>> 0}\0${namespace}`);
}

/**
 * Creates the page-lifetime deterministic sequence exposed as
 * `TransmuteOverlay.random`. The sequence is intentionally stateful.
 */
export function createHtmlOverlayRandom(seed: number): () => number {
  let state = randomSeed(seed, "sequence");
  return () => {
    const [nextState, value] = nextMulberry32(state);
    state = nextState;
    return value;
  };
}

/**
 * Returns a stateless, domain-separated value for absolute-frame authoring.
 * Its result is independent of calls to `createHtmlOverlayRandom`.
 */
export function htmlOverlayRandomFor(seed: number, key: string): number {
  const [, value] = nextMulberry32(randomSeed(seed, `key\0${key}`));
  return value;
}
