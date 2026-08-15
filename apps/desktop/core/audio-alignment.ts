import {
  AlignmentCandidateSchema,
  AudioAlignmentAnalysisV1Schema,
  type AlignmentCandidate,
  type AnalysisSubject,
  type AudioAlignmentAnalysisV1,
} from "../contracts/analysis";

const EPSILON = 1e-12;
const DEFAULT_MINIMUM_CORRELATION = 0.55;
const DEFAULT_AMBIGUITY_MARGIN = 0.08;
const DEFAULT_DISTINCT_PEAK_US = 100_000;
const MAX_CORRELATION_SAMPLES = 4_096;

export interface EnvelopeSeries {
  readonly hopUs: number;
  readonly startUs?: number;
  readonly values: readonly number[];
}

export interface AudioAlignmentOptions {
  readonly ambiguityMargin?: number;
  readonly distinctPeakUs?: number;
  readonly maxOffsetUs?: number;
  readonly minimumCorrelation?: number;
}

export interface AnalyzeAudioAlignmentInput {
  readonly analysisId: string;
  readonly config: AudioAlignmentAnalysisV1["config"];
  readonly createdAt: string;
  readonly inputDigest: string;
  readonly options?: AudioAlignmentOptions;
  readonly reference: AnalysisSubject;
  readonly referenceEnvelope: EnvelopeSeries;
  readonly target: AnalysisSubject;
  readonly targetEnvelope: EnvelopeSeries;
  readonly tool: AudioAlignmentAnalysisV1["tool"];
}

interface LagScore {
  readonly lagSamples: number;
  readonly overlapSamples: number;
  readonly score: number;
}

interface LocalMatch extends LagScore {
  readonly ambiguity: number;
  readonly referenceSample: number;
  readonly targetSample: number;
  readonly windowSamples: number;
}

interface FittedCandidate {
  readonly candidate: AlignmentCandidate;
  readonly matches: readonly LocalMatch[];
  readonly score: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : ordered[middle] ?? 0;
}

function assertSeries(series: EnvelopeSeries, label: string): Required<EnvelopeSeries> {
  if (!Number.isSafeInteger(series.hopUs) || series.hopUs <= 0) {
    throw new TypeError(`${label} envelope hopUs must be a positive safe integer.`);
  }
  const startUs = series.startUs ?? 0;
  if (!Number.isSafeInteger(startUs) || startUs < 0) {
    throw new TypeError(`${label} envelope startUs must be a nonnegative safe integer.`);
  }
  if (series.values.some(value => !Number.isFinite(value))) {
    throw new TypeError(`${label} envelope values must be finite.`);
  }
  return { hopUs: series.hopUs, startUs, values: series.values };
}

function variance(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

/**
 * Pearson correlation at a lag where a positive lag means the matching target
 * feature occurs later than the reference feature.
 */
export function envelopeCorrelationAtLag(
  reference: readonly number[],
  target: readonly number[],
  lagSamples: number,
  maximumSamples = MAX_CORRELATION_SAMPLES,
): LagScore {
  if (!Number.isSafeInteger(lagSamples)) throw new TypeError("lagSamples must be a safe integer.");
  const referenceStart = Math.max(0, -lagSamples);
  const targetStart = Math.max(0, lagSamples);
  const overlapSamples = Math.min(reference.length - referenceStart, target.length - targetStart);
  if (overlapSamples < 2) return { lagSamples, overlapSamples: Math.max(0, overlapSamples), score: -1 };

  const stride = Math.max(1, Math.ceil(overlapSamples / maximumSamples));
  let count = 0;
  let referenceSum = 0;
  let targetSum = 0;
  for (let offset = 0; offset < overlapSamples; offset += stride) {
    const left = reference[referenceStart + offset] ?? 0;
    const right = target[targetStart + offset] ?? 0;
    count += 1;
    referenceSum += left;
    targetSum += right;
  }
  const referenceMean = referenceSum / count;
  const targetMean = targetSum / count;
  let covariance = 0;
  let referenceEnergy = 0;
  let targetEnergy = 0;
  for (let offset = 0; offset < overlapSamples; offset += stride) {
    const left = (reference[referenceStart + offset] ?? 0) - referenceMean;
    const right = (target[targetStart + offset] ?? 0) - targetMean;
    covariance += left * right;
    referenceEnergy += left * left;
    targetEnergy += right * right;
  }
  const denominator = Math.sqrt(Math.max(0, referenceEnergy) * Math.max(0, targetEnergy));
  return {
    lagSamples,
    overlapSamples,
    score: denominator <= EPSILON ? -1 : clamp(covariance / denominator, -1, 1),
  };
}

function scanLags(
  reference: readonly number[],
  target: readonly number[],
  minimumLag: number,
  maximumLag: number,
): readonly LagScore[] {
  const width = Math.max(0, maximumLag - minimumLag + 1);
  const coarseStride = Math.max(1, Math.ceil(width / 4_001));
  const coarse: LagScore[] = [];
  for (let lag = minimumLag; lag <= maximumLag; lag += coarseStride) {
    coarse.push(envelopeCorrelationAtLag(reference, target, lag));
  }
  if (coarseStride === 1) return coarse;

  const promising = [...coarse]
    .sort((left, right) => right.score - left.score || left.lagSamples - right.lagSamples)
    .slice(0, 8);
  const refinedLags = new Set<number>();
  for (const candidate of promising) {
    for (
      let lag = Math.max(minimumLag, candidate.lagSamples - coarseStride);
      lag <= Math.min(maximumLag, candidate.lagSamples + coarseStride);
      lag += 1
    ) refinedLags.add(lag);
  }
  return [...refinedLags].sort((left, right) => left - right)
    .map(lag => envelopeCorrelationAtLag(reference, target, lag));
}

function distinctPeaks(scores: readonly LagScore[], separationSamples: number): readonly LagScore[] {
  const ordered = [...scores].sort((left, right) => right.score - left.score || left.lagSamples - right.lagSamples);
  const selected: LagScore[] = [];
  for (const score of ordered) {
    if (selected.every(candidate => Math.abs(candidate.lagSamples - score.lagSamples) >= separationSamples)) {
      selected.push(score);
      if (selected.length === 32) break;
    }
  }
  return selected;
}

function ambiguity(best: number, competitor: number | undefined, margin: number): number {
  if (competitor === undefined || competitor < -0.5) return 0;
  if (margin <= 0) return competitor >= best ? 1 : 0;
  return clamp((competitor - (best - margin)) / margin, 0, 1);
}

function windowCorrelation(
  reference: readonly number[],
  target: readonly number[],
  referenceCenter: number,
  lagSamples: number,
  windowSamples: number,
): LagScore {
  const half = Math.max(1, Math.floor(windowSamples / 2));
  const referenceStart = Math.max(0, referenceCenter - half);
  const referenceEnd = Math.min(reference.length, referenceCenter + half);
  const targetStart = referenceStart + lagSamples;
  const targetEnd = referenceEnd + lagSamples;
  if (targetStart < 0 || targetEnd > target.length || referenceEnd - referenceStart < 2) {
    return { lagSamples, overlapSamples: 0, score: -1 };
  }
  const correlation = envelopeCorrelationAtLag(
    reference.slice(referenceStart, referenceEnd),
    target.slice(targetStart, targetEnd),
    0,
  );
  return { ...correlation, lagSamples };
}

function localMatches(
  reference: readonly number[],
  target: readonly number[],
  initialLag: number,
  windowSamples: number,
  maximumDriftSamples: number,
  ambiguityMargin: number,
): readonly LocalMatch[] {
  const half = Math.max(2, Math.floor(windowSamples / 2));
  const minimumCenter = Math.max(half, half - initialLag + maximumDriftSamples);
  const maximumCenter = Math.min(
    reference.length - half,
    target.length - half - initialLag - maximumDriftSamples,
  );
  if (maximumCenter < minimumCenter) return [];
  const desiredMatches = Math.max(2, Math.min(32, Math.ceil((maximumCenter - minimumCenter + 1) / Math.max(1, windowSamples))));
  const centers = new Set<number>();
  for (let index = 0; index < desiredMatches; index += 1) {
    const ratio = desiredMatches === 1 ? 0.5 : index / (desiredMatches - 1);
    centers.add(Math.round(minimumCenter + ratio * (maximumCenter - minimumCenter)));
  }

  const matches: LocalMatch[] = [];
  for (const referenceCenter of [...centers].sort((left, right) => left - right)) {
    const candidates: LagScore[] = [];
    for (let delta = -maximumDriftSamples; delta <= maximumDriftSamples; delta += 1) {
      candidates.push(windowCorrelation(reference, target, referenceCenter, initialLag + delta, windowSamples));
    }
    const ranked = candidates.sort((left, right) => right.score - left.score || left.lagSamples - right.lagSamples);
    const best = ranked[0];
    if (best === undefined || best.score <= 0) continue;
    const competitor = ranked.find(candidate => Math.abs(candidate.lagSamples - best.lagSamples) >= 2);
    matches.push({
      ...best,
      ambiguity: ambiguity(best.score, competitor?.score, ambiguityMargin),
      referenceSample: referenceCenter,
      targetSample: referenceCenter + best.lagSamples,
      windowSamples,
    });
  }
  return matches;
}

function theilSen(matches: readonly LocalMatch[]): { readonly intercept: number; readonly slope: number } {
  if (matches.length < 2) {
    const only = matches[0];
    return { intercept: only === undefined ? 0 : only.targetSample - only.referenceSample, slope: 1 };
  }
  const slopes: number[] = [];
  for (let leftIndex = 0; leftIndex < matches.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < matches.length; rightIndex += 1) {
      const left = matches[leftIndex]!;
      const right = matches[rightIndex]!;
      const denominator = right.referenceSample - left.referenceSample;
      if (denominator > 0) slopes.push((right.targetSample - left.targetSample) / denominator);
    }
  }
  const slope = median(slopes);
  return {
    intercept: median(matches.map(match => match.targetSample - slope * match.referenceSample)),
    slope,
  };
}

function candidateIdentifier(rank: number): AlignmentCandidate["candidateId"] {
  return `candidate_alignment${String(rank + 1).padStart(4, "0")}` as AlignmentCandidate["candidateId"];
}

function fitCandidate(
  reference: Required<EnvelopeSeries>,
  target: Required<EnvelopeSeries>,
  peak: LagScore,
  competitorScore: number | undefined,
  rank: number,
  config: AudioAlignmentAnalysisV1["config"],
  options: Required<Pick<AudioAlignmentOptions, "ambiguityMargin" | "distinctPeakUs" | "minimumCorrelation">>,
): FittedCandidate {
  const hopUs = reference.hopUs;
  const windowSamples = Math.max(4, Math.round(config.windowUs / hopUs));
  const durationSamples = Math.min(reference.values.length, target.values.length);
  const maximumDriftSamples = Math.max(2, Math.ceil(durationSamples * config.maxDriftPpm / 1_000_000) + 1);
  let matches = localMatches(
    reference.values,
    target.values,
    peak.lagSamples,
    windowSamples,
    maximumDriftSamples,
    options.ambiguityMargin,
  );
  if (matches.length < 2) {
    const referenceStart = Math.max(0, -peak.lagSamples);
    const targetStart = Math.max(0, peak.lagSamples);
    const overlap = Math.max(2, peak.overlapSamples);
    matches = [
      {
        ...peak,
        ambiguity: ambiguity(peak.score, competitorScore, options.ambiguityMargin),
        referenceSample: referenceStart,
        targetSample: targetStart,
        windowSamples: Math.min(windowSamples, overlap),
      },
      {
        ...peak,
        ambiguity: ambiguity(peak.score, competitorScore, options.ambiguityMargin),
        referenceSample: referenceStart + overlap - 1,
        targetSample: targetStart + overlap - 1,
        windowSamples: Math.min(windowSamples, overlap),
      },
    ];
  }
  const fitted = theilSen(matches);
  const driftPpm = (fitted.slope - 1) * 1_000_000;
  const residualsUs = matches.map(match => Math.abs(
    match.targetSample - (fitted.intercept + fitted.slope * match.referenceSample)
  ) * hopUs);
  const referenceOverlapStart = Math.max(0, Math.ceil(-fitted.intercept / Math.max(EPSILON, fitted.slope)));
  const referenceOverlapEnd = Math.min(
    reference.values.length - 1,
    Math.floor((target.values.length - 1 - fitted.intercept) / Math.max(EPSILON, fitted.slope)),
  );
  const anchorReferenceSamples = referenceOverlapEnd > referenceOverlapStart
    ? [referenceOverlapStart, referenceOverlapEnd]
    : [matches[0]!.referenceSample, matches.at(-1)!.referenceSample];
  const anchors = anchorReferenceSamples.map(referenceSample => ({
    referenceAssetTimeUs: Math.round(reference.startUs + referenceSample * hopUs),
    targetAssetTimeUs: Math.max(0, Math.round(target.startUs + (fitted.intercept + fitted.slope * referenceSample) * hopUs)),
  }));
  const candidateAmbiguity = ambiguity(peak.score, competitorScore, options.ambiguityMargin);
  const residualPenalty = 1 - clamp(median(residualsUs) / Math.max(config.windowUs / 4, hopUs), 0, 1);
  const overlapUs = Math.max(0, (referenceOverlapEnd - referenceOverlapStart) * hopUs);
  const overlapFactor = clamp(overlapUs / Math.max(config.minimumOverlapUs, 1), 0, 1);
  const correlationConfidence = clamp((peak.score - options.minimumCorrelation) / Math.max(0.001, 1 - options.minimumCorrelation), 0, 1);
  const confidence = clamp(
    0.55 * correlationConfidence + 0.25 * residualPenalty + 0.2 * overlapFactor,
    0,
    1,
  );
  const firstAnchor = anchors[0]!;
  const initialOffsetUs = firstAnchor.targetAssetTimeUs - firstAnchor.referenceAssetTimeUs;
  const candidate = AlignmentCandidateSchema.parse({
    ambiguity: candidateAmbiguity,
    anchors,
    autoApplicable: confidence >= 0.8
      && candidateAmbiguity <= 0.2
      && Math.abs(driftPpm) <= config.maxDriftPpm,
    candidateId: candidateIdentifier(rank),
    confidence,
    driftPpm: clamp(driftPpm, -100_000, 100_000),
    initialOffsetUs,
    maxResidualUs: Math.round(Math.max(...residualsUs, 0)),
    medianResidualUs: Math.round(median(residualsUs)),
    overlapUs: Math.round(overlapUs),
    peakRatio: peak.score <= 0
      ? 0
      : peak.score / Math.max(EPSILON, Math.max(0, competitorScore ?? 0)),
  });
  return { candidate, matches, score: peak.score };
}

/** Analyze already-decoded numeric envelopes without filesystem or process effects. */
export function analyzeAudioAlignment(input: AnalyzeAudioAlignmentInput): AudioAlignmentAnalysisV1 {
  const reference = assertSeries(input.referenceEnvelope, "Reference");
  const target = assertSeries(input.targetEnvelope, "Target");
  if (reference.hopUs !== target.hopUs) {
    throw new TypeError("Alignment envelopes must use the same hopUs.");
  }
  const hopUs = reference.hopUs;
  const minimumOverlapSamples = Math.max(2, Math.ceil(input.config.minimumOverlapUs / hopUs));
  const base = {
    analysisId: input.analysisId,
    config: input.config,
    createdAt: input.createdAt,
    inputDigest: input.inputDigest,
    kind: "atet.audio-alignment-analysis" as const,
    reference: input.reference,
    schemaVersion: 1 as const,
    target: input.target,
    tool: input.tool,
  };
  const noMatch = (
    reason: "insufficient-overlap" | "low-correlation" | "silent-input" | "unrelated-input",
    diagnostic: string,
  ): AudioAlignmentAnalysisV1 => AudioAlignmentAnalysisV1Schema.parse({
    ...base,
    matches: [],
    result: { diagnostics: [diagnostic], reason, status: "no-match" },
  });

  if (Math.min(reference.values.length, target.values.length) < minimumOverlapSamples) {
    return noMatch("insufficient-overlap", "The feature series do not contain the configured minimum overlap.");
  }
  if (variance(reference.values) <= EPSILON || variance(target.values) <= EPSILON) {
    return noMatch("silent-input", "At least one feature series has no usable variation.");
  }

  const options = {
    ambiguityMargin: input.options?.ambiguityMargin ?? DEFAULT_AMBIGUITY_MARGIN,
    distinctPeakUs: input.options?.distinctPeakUs ?? DEFAULT_DISTINCT_PEAK_US,
    minimumCorrelation: input.options?.minimumCorrelation ?? DEFAULT_MINIMUM_CORRELATION,
  };
  if (!Number.isFinite(options.ambiguityMargin) || options.ambiguityMargin < 0 || options.ambiguityMargin > 2) {
    throw new TypeError("ambiguityMargin must be finite and between zero and two.");
  }
  if (!Number.isSafeInteger(options.distinctPeakUs) || options.distinctPeakUs < 0) {
    throw new TypeError("distinctPeakUs must be a nonnegative safe integer.");
  }
  if (!Number.isFinite(options.minimumCorrelation) || options.minimumCorrelation < -1 || options.minimumCorrelation > 1) {
    throw new TypeError("minimumCorrelation must be finite and between negative one and one.");
  }
  if (
    input.options?.maxOffsetUs !== undefined
    && (!Number.isSafeInteger(input.options.maxOffsetUs) || input.options.maxOffsetUs < 0)
  ) {
    throw new TypeError("maxOffsetUs must be a nonnegative safe integer.");
  }
  const maxPossibleLag = Math.max(reference.values.length, target.values.length) - minimumOverlapSamples;
  const configuredMaximum = input.options?.maxOffsetUs === undefined
    ? maxPossibleLag
    : Math.min(maxPossibleLag, Math.floor(input.options.maxOffsetUs / hopUs));
  const scores = scanLags(reference.values, target.values, -configuredMaximum, configuredMaximum)
    .filter(score => score.overlapSamples >= minimumOverlapSamples);
  const peaks = distinctPeaks(scores, Math.max(2, Math.ceil(options.distinctPeakUs / hopUs)));
  const best = peaks[0];
  if (best === undefined || best.score < options.minimumCorrelation) {
    return noMatch(
      best === undefined || best.score < 0.15 ? "unrelated-input" : "low-correlation",
      `The strongest normalized envelope correlation was ${best?.score.toFixed(4) ?? "unavailable"}.`,
    );
  }

  const competitive = peaks.filter(peak => peak.score >= Math.max(options.minimumCorrelation, best.score - options.ambiguityMargin));
  const selectedPeaks = competitive.length > 1 ? competitive.slice(0, 32) : [best];
  const fitted = selectedPeaks.map((peak, rank) => fitCandidate(
    reference,
    target,
    peak,
    peaks.find(candidate => candidate !== peak)?.score,
    rank,
    input.config,
    options,
  ));
  const matches = fitted[0]!.matches.map(match => ({
    ambiguity: match.ambiguity,
    confidence: clamp((match.score + 1) / 2, 0, 1),
    referenceAssetTimeUs: Math.round(reference.startUs + match.referenceSample * hopUs),
    targetAssetTimeUs: Math.round(target.startUs + match.targetSample * hopUs),
    windowUs: Math.round(match.windowSamples * hopUs),
  }));
  const candidates = fitted.map(item => item.candidate);
  return AudioAlignmentAnalysisV1Schema.parse({
    ...base,
    matches,
    result: competitive.length > 1
      ? { candidates, reason: "periodic-or-competing-matches", status: "ambiguous" }
      : { candidates, status: "matched" },
  });
}
