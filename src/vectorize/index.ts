export { vectorizeDefaultLimits, vectorizeHardLimits } from "./limits.js"
export {
  alphaPlaneTraceRgba,
  dominantOklabDuotoneModel,
  lowAlphaMassRatio,
  normalizedAlphaRmse,
  normalizedPremultipliedRmse,
  sanitizedTraceRgba,
} from "./metrics.js"
export { assertSafeCanonicalSvg, countSvgPaths } from "./svg.js"
export { VTRACER_VERSION, vtracerReleases } from "./tool.js"
export { vectorizeImage } from "./vectorize.js"
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
} from "./types.js"
