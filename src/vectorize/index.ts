export { vectorizeDefaultLimits, vectorizeHardLimits } from "./limits.ts"
export {
  alphaPlaneTraceRgba,
  dominantOklabDuotoneModel,
  lowAlphaMassRatio,
  normalizedAlphaRmse,
  normalizedPremultipliedRmse,
  sanitizedTraceRgba,
} from "./metrics.ts"
export { assertSafeCanonicalSvg, countSvgPaths } from "./svg.ts"
export { VTRACER_VERSION, vtracerReleases } from "./tool.ts"
export { vectorizeImage } from "./vectorize.ts"
export {
  VectorizeError,
  vectorizeProfileNames,
  type VectorizeErrorCode,
  type VectorizeInput,
  type VectorizeLimits,
  type VectorizeOptions,
  type VectorizeOutputMode,
  type VectorizeProfile,
  type VectorizeProvenance,
  type VectorizeQualityReceipt,
  type VectorizeReceipt,
  type VectorizeRepresentation,
  type VectorizeResult,
} from "./types.ts"
