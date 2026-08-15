import {
  FillerCandidateSchema,
  SpeechAnalysisV1Schema,
  TranscriptWordSchema,
  type AnalysisSubject,
  type FillerCandidate,
  type MusicAnalysisV1,
  type SpeechAnalysisV1,
} from "../contracts/analysis";

type SourceRange = { readonly endUs: number; readonly startUs: number };
type TranscribedResult = Extract<SpeechAnalysisV1["result"], { readonly status: "transcribed" }>;
type TranscriptWord = TranscribedResult["words"][number];
type SpeechUtterance = TranscribedResult["utterances"][number];

const FILLED_PAUSES = new Set(["ah", "eh", "er", "erm", "hm", "hmm", "mm", "uh", "uhh", "um", "umm"]);
const CONTEXTUAL_FILLERS = new Set(["actually", "like", "well"]);
const PHRASE_FILLERS = [
  { confidence: 0.97, tokens: ["you", "know"] },
  { confidence: 0.97, tokens: ["i", "mean"] },
  { confidence: 0.93, tokens: ["sort", "of"] },
  { confidence: 0.9, tokens: ["kind", "of"] },
  { confidence: 0.92, tokens: ["basically"] },
  { confidence: 0.91, tokens: ["literally"] },
] as const;

export interface SpeechWordInput {
  readonly confidence: number;
  readonly range: SourceRange;
  readonly speaker?: string | null;
  readonly text: string;
}

export interface MusicProtectionRegion {
  readonly range: SourceRange;
}

export interface DetectedFillerSpan {
  readonly classification: FillerCandidate["classification"];
  readonly lexicalConfidence: number;
  readonly wordEndExclusive: number;
  readonly wordStart: number;
}

export interface AnalyzeSpeechInput {
  readonly analysisId: string;
  readonly config: SpeechAnalysisV1["config"];
  readonly createdAt: string;
  readonly detectedLanguage: string;
  readonly durationUs: number;
  readonly inputDigest: string;
  readonly musicRegions?: readonly MusicProtectionRegion[] | MusicAnalysisV1["musicRegions"];
  readonly subject: AnalysisSubject;
  readonly tool: SpeechAnalysisV1["tool"];
  readonly words: readonly SpeechWordInput[];
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedToken(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function hasFalseStartMarker(text: string): boolean {
  return /(?:-|–|—|\.\.)$/u.test(text.trim());
}

function phraseAt(tokens: readonly string[], index: number): DetectedFillerSpan | null {
  for (const phrase of PHRASE_FILLERS) {
    if (phrase.tokens.every((token, offset) => tokens[index + offset] === token)) {
      return {
        classification: "phrase-filler",
        lexicalConfidence: phrase.confidence,
        wordEndExclusive: index + phrase.tokens.length,
        wordStart: index,
      };
    }
  }
  return null;
}

function spansOverlap(left: DetectedFillerSpan, right: DetectedFillerSpan): boolean {
  return left.wordStart < right.wordEndExclusive && right.wordStart < left.wordEndExclusive;
}

/** Merge adjacent detections of the same class without crossing a lexical gap. */
export function mergeFillerSpans(
  spans: readonly DetectedFillerSpan[],
): readonly DetectedFillerSpan[] {
  const ordered = [...spans].sort((left, right) => left.wordStart - right.wordStart
    || right.wordEndExclusive - left.wordEndExclusive
    || left.classification.localeCompare(right.classification));
  const merged: DetectedFillerSpan[] = [];
  for (const span of ordered) {
    const prior = merged.at(-1);
    if (
      prior !== undefined
      && prior.classification === span.classification
      && span.wordStart <= prior.wordEndExclusive
    ) {
      merged[merged.length - 1] = {
        classification: prior.classification,
        lexicalConfidence: Math.min(prior.lexicalConfidence, span.lexicalConfidence),
        wordEndExclusive: Math.max(prior.wordEndExclusive, span.wordEndExclusive),
        wordStart: prior.wordStart,
      };
    } else if (prior === undefined || !spansOverlap(prior, span)) {
      merged.push(span);
    }
  }
  return merged;
}

/** Classify lexical filler spans. A standalone `like` is always contextual. */
export function classifyFillerWords(words: readonly Pick<SpeechWordInput, "text">[]): readonly DetectedFillerSpan[] {
  const tokens = words.map(word => normalizedToken(word.text));
  const primary: DetectedFillerSpan[] = [];
  for (let index = 0; index < words.length;) {
    if (FILLED_PAUSES.has(tokens[index] ?? "")) {
      let end = index + 1;
      while (end < words.length && FILLED_PAUSES.has(tokens[end] ?? "")) end += 1;
      primary.push({
        classification: "filled-pause",
        lexicalConfidence: 0.99,
        wordEndExclusive: end,
        wordStart: index,
      });
      index = end;
      continue;
    }
    const phrase = phraseAt(tokens, index);
    if (phrase !== null) {
      primary.push(phrase);
      index = phrase.wordEndExclusive;
      continue;
    }
    if (hasFalseStartMarker(words[index]?.text ?? "")) {
      primary.push({
        classification: "false-start",
        lexicalConfidence: 0.94,
        wordEndExclusive: index + 1,
        wordStart: index,
      });
      index += 1;
      continue;
    }
    if (CONTEXTUAL_FILLERS.has(tokens[index] ?? "")) {
      primary.push({
        classification: "contextual",
        lexicalConfidence: tokens[index] === "like" ? 0.82 : 0.76,
        wordEndExclusive: index + 1,
        wordStart: index,
      });
    }
    index += 1;
  }

  const repetitions: DetectedFillerSpan[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "" || token !== tokens[index - 1]) continue;
    const repetition: DetectedFillerSpan = {
      classification: "repetition",
      lexicalConfidence: 0.96,
      wordEndExclusive: index + 1,
      wordStart: index,
    };
    if (!primary.some(span => spansOverlap(span, repetition))) repetitions.push(repetition);
  }
  return mergeFillerSpans([...primary, ...repetitions]);
}

function rangesOverlap(left: SourceRange, right: SourceRange): boolean {
  return left.startUs < right.endUs && right.startUs < left.endUs;
}

function transcriptWords(words: readonly SpeechWordInput[], durationUs: number): readonly TranscriptWord[] {
  const ordered = [...words].sort((left, right) => left.range.startUs - right.range.startUs
    || left.range.endUs - right.range.endUs
    || left.text.localeCompare(right.text));
  const parsed = ordered.map((word, wordIndex) => TranscriptWordSchema.parse({
    confidence: word.confidence,
    range: word.range,
    speaker: word.speaker ?? null,
    text: word.text,
    wordIndex,
  }));
  for (let index = 0; index < parsed.length; index += 1) {
    const word = parsed[index]!;
    if (word.range.endUs > durationUs) throw new RangeError("Transcript words must fit inside durationUs.");
    if (index > 0 && word.range.startUs < parsed[index - 1]!.range.endUs) {
      throw new RangeError("Transcript words must not overlap.");
    }
  }
  return parsed;
}

function joinWords(words: readonly TranscriptWord[]): string {
  return words.map(word => word.text).join(" ").replace(/\s+([,.;:!?])/gu, "$1");
}

/** Group words on speaker changes and one-second transcript gaps. */
export function deriveSpeechUtterances(
  words: readonly TranscriptWord[],
  maximumGapUs = 1_000_000,
): readonly SpeechUtterance[] {
  if (!Number.isSafeInteger(maximumGapUs) || maximumGapUs < 0) {
    throw new TypeError("maximumGapUs must be a nonnegative safe integer.");
  }
  const groups: { end: number; start: number }[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const priorWord = words[index - 1];
    const priorGroup = groups.at(-1);
    if (
      priorWord === undefined
      || priorGroup === undefined
      || word.range.startUs - priorWord.range.endUs > maximumGapUs
      || word.speaker !== priorWord.speaker
    ) {
      groups.push({ end: index + 1, start: index });
    } else {
      priorGroup.end = index + 1;
    }
  }
  return groups.map(group => {
    const selected = words.slice(group.start, group.end);
    return {
      range: { endUs: selected.at(-1)!.range.endUs, startUs: selected[0]!.range.startUs },
      text: joinWords(selected),
      wordEndExclusive: group.end,
      wordStart: group.start,
    };
  });
}

function fillerIdentifier(index: number): FillerCandidate["candidateId"] {
  return `filler_candidate${String(index + 1).padStart(4, "0")}` as FillerCandidate["candidateId"];
}

/** Build conservative cut suggestions from lexical spans and acoustic gaps. */
export function buildFillerCandidates(
  words: readonly TranscriptWord[],
  config: SpeechAnalysisV1["config"],
  durationUs: number,
  musicRegions: readonly MusicProtectionRegion[] = [],
): readonly FillerCandidate[] {
  const spans = classifyFillerWords(words);
  const candidates: FillerCandidate[] = [];
  for (const span of spans) {
    const selected = words.slice(span.wordStart, span.wordEndExclusive);
    const first = selected[0];
    const last = selected.at(-1);
    if (first === undefined || last === undefined) continue;
    const range = { endUs: last.range.endUs, startUs: first.range.startUs };
    const transcriptConfidence = Math.min(...selected.map(word => word.confidence));
    const confidence = clamp(span.lexicalConfidence * transcriptConfidence);
    if (confidence < config.minimumFillerConfidence) continue;
    const prior = words[span.wordStart - 1];
    const next = words[span.wordEndExclusive];
    const beforeGapUs = prior === undefined ? range.startUs : Math.max(0, range.startUs - prior.range.endUs);
    const afterGapUs = next === undefined ? Math.max(0, durationUs - range.endUs) : Math.max(0, next.range.startUs - range.endUs);
    const boundaryScale = Math.max(1, config.speechHandleUs);
    const acousticBoundaryConfidence = config.speechHandleUs === 0
      ? 1
      : Math.min(clamp(beforeGapUs / boundaryScale), clamp(afterGapUs / boundaryScale));
    const contextual = span.classification === "contextual";
    const proposedCut = {
      endUs: Math.min(durationUs, range.endUs + Math.min(config.speechHandleUs, afterGapUs)),
      startUs: Math.max(0, range.startUs - Math.min(config.speechHandleUs, beforeGapUs)),
    };
    const musicProtected = musicRegions.some(region =>
      rangesOverlap(range, region.range) || rangesOverlap(proposedCut, region.range));
    const recommendedCut = musicProtected || contextual ? null : proposedCut;
    const autoApplicable = recommendedCut !== null
      && !musicProtected
      && !contextual
      && confidence >= 0.9
      && acousticBoundaryConfidence >= 0.8;
    candidates.push(FillerCandidateSchema.parse({
      acousticBoundaryConfidence,
      autoApplicable,
      candidateId: fillerIdentifier(candidates.length),
      classification: span.classification,
      confidence,
      musicProtected,
      range,
      recommendedCut,
      text: joinWords(selected),
      wordEndExclusive: span.wordEndExclusive,
      wordStart: span.wordStart,
    }));
  }
  return candidates;
}

/** Analyze an owned word transcript into safe, inspectable filler suggestions. */
export function analyzeSpeech(input: AnalyzeSpeechInput): SpeechAnalysisV1 {
  if (!Number.isSafeInteger(input.durationUs) || input.durationUs < 0) {
    throw new TypeError("durationUs must be a nonnegative safe integer.");
  }
  const base = {
    analysisId: input.analysisId,
    config: input.config,
    createdAt: input.createdAt,
    durationUs: input.durationUs,
    inputDigest: input.inputDigest,
    kind: "atet.speech-analysis" as const,
    schemaVersion: 1 as const,
    subject: input.subject,
    tool: input.tool,
  };
  if (input.words.length === 0) {
    return SpeechAnalysisV1Schema.parse({
      ...base,
      result: { detectedLanguage: input.detectedLanguage || null, reason: "no-speech", status: "no-speech" },
    });
  }
  const words = transcriptWords(input.words, input.durationUs);
  return SpeechAnalysisV1Schema.parse({
    ...base,
    result: {
      detectedLanguage: input.detectedLanguage,
      fillers: buildFillerCandidates(words, input.config, input.durationUs, input.musicRegions ?? []),
      status: "transcribed",
      utterances: deriveSpeechUtterances(words),
      words,
    },
  });
}
