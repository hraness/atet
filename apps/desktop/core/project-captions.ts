import {
  SpeechAnalysisV1Schema,
  type SpeechAnalysisV1,
} from "../contracts/analysis";
import type { SourceInterval } from "../contracts/edit";
import {
  ProjectEditPlanV1Schema,
  VideoProjectV1Schema,
  type ProjectEditPlanV1,
  type VideoProjectV1,
} from "../contracts/project";
import {
  canonicalJson,
  canonicalJsonSha256,
  sha256Hex,
} from "./canonical-json";
import { hashProjectStructure } from "./project-plan";
import {
  buildProjectOutputTimeMap,
  interpolateMicroseconds,
  projectSyncSegments,
  type ProjectOutputSegment,
  type ProjectSyncSegment,
} from "./project-time";

export const PROJECT_CAPTION_LIMITS = Object.freeze({
  maximumVisibleCues: 5_000,
  maximumVisibleWords: 20_000,
});

export interface ProjectCaptionOutput {
  /** When supplied, binds compilation to the already-planned output clock. */
  readonly durationUs?: number;
  readonly pixelHeight: number;
  readonly pixelWidth: number;
}

export type ProjectCaptionLines =
  | readonly [string]
  | readonly [string, string];

export interface ProjectCaptionCue {
  readonly lines: ProjectCaptionLines;
  readonly outputRange: SourceInterval;
  readonly projectRange: SourceInterval;
  readonly sourceWordIndices: readonly number[];
}

export interface SocialCaptionSvg {
  readonly bottomSafeMargin: number;
  readonly intrinsicHeight: number;
  readonly intrinsicWidth: number;
  readonly svg: string;
}

export interface CompileProjectCaptionCuesInput {
  readonly analysis: SpeechAnalysisV1;
  readonly output: ProjectCaptionOutput;
  readonly placementId: VideoProjectV1["placements"][number]["placementId"] | string;
  readonly plan: ProjectEditPlanV1;
  readonly project: VideoProjectV1;
}

interface CaptionProfile {
  readonly fontSize: number;
  readonly maximumCueDurationUs: number;
  readonly maximumGapUs: number;
  readonly maximumLineUnits: number;
  readonly maximumTokenFragmentsPerCue: number;
  readonly maximumWordsPerCue: number;
  readonly safeBottomFraction: number;
  readonly targetCardWidth: number;
}

interface MappedCaptionToken {
  readonly assetRange: SourceInterval;
  readonly mappingKey: string;
  readonly outputRange: SourceInterval;
  readonly projectRange: SourceInterval;
  readonly sourceWordIndex: number;
  readonly speaker: string | null;
  readonly text: string;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter("und", {
  granularity: "grapheme",
});
const CAPTION_WIDTH_UNITS_PER_EM = 1_000;
const EAST_ASIAN_WIDE_GRAPHEME = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\uff01-\uff60\uffe0-\uffe6]/u;
const EMOJI_OR_FLAG_GRAPHEME = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const ASCII_WIDE_GRAPHEME = /^[%&@MWmw]$/u;
const ASCII_NARROW_GRAPHEME = /^[!"'(),.:;I\u005b\u005d`fijlt|]$/u;
const ASCII_UPPER_OR_DIGIT_GRAPHEME = /^[0-9A-Z]$/u;
const LETTER_OR_NUMBER = /[\p{Letter}\p{Number}]/gu;
const WHITESPACE_GRAPHEME = /^\s+$/u;
const CJK_WITHOUT_WORD_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const NO_SPACE_BEFORE = /^[,.;:!?%\u2026\u3001\u3002\uff0c\uff01\uff1a\uff1b\uff1f)\uff09\u3009\u300b\u3011\u300d\u300f\u2019\u201d\]}]/u;
const NO_SPACE_AFTER = /[(\uff08\u3008\u300a\u3010\u300c\u300e\u2018\u201c\u005b{]$/u;
const CONTRACTION_SUFFIX = /^(?:['\u2019](?:d|ll|m|re|s|t|ve))(?:\b|$)/iu;
const CUE_ENDING_PUNCTUATION = /[.!?;:\u2026\u3002\uff01\uff1a\uff1b\uff1f](?:['"\u2019\u201d)\]}\uff09\u3011\u300d\u300f\u300b]*)$/u;
const CLOSING_DELIMITER_TOKEN = /^["'\u2019\u201d)\]}\uff09\u3011\u300d\u300f\u300b]+$/u;
const PUNCTUATION_TOKEN = /^\p{Punctuation}+$/u;
const LETTER_OR_NUMBER_CHARACTER = /^[\p{Letter}\p{Number}]$/u;
const MAXIMUM_ATTACHED_PUNCTUATION_FRAGMENTS = 8;

interface CaptionGrapheme {
  readonly endIndex: number;
  readonly segment: string;
  readonly startIndex: number;
  readonly widthUnits: number;
}

function requireOutput(output: ProjectCaptionOutput): void {
  if (
    !Number.isSafeInteger(output.pixelWidth)
    || output.pixelWidth <= 0
    || output.pixelWidth > 16_384
    || !Number.isSafeInteger(output.pixelHeight)
    || output.pixelHeight <= 0
    || output.pixelHeight > 16_384
    || output.pixelWidth * output.pixelHeight > 134_217_728
  ) {
    throw new RangeError("Caption output dimensions are invalid or exceed the 128-megapixel bound.");
  }
  if (
    output.durationUs !== undefined
    && (!Number.isSafeInteger(output.durationUs) || output.durationUs < 0)
  ) {
    throw new RangeError("Caption output duration must be a nonnegative safe integer.");
  }
}

function captionProfile(output: ProjectCaptionOutput): CaptionProfile {
  requireOutput(output);
  const aspect = output.pixelWidth / output.pixelHeight;
  const family = aspect >= 1.15
    ? "landscape"
    : aspect <= 0.68
      ? "portrait"
      : "feed";
  const geometry = family === "landscape"
    ? {
        fontScale: 0.052,
        maximumCueDurationUs: 3_400_000,
        maximumGapUs: 700_000,
        maximumWordsPerCue: 12,
        safeBottomFraction: 0.075,
        widthFraction: 0.78,
      }
    : family === "portrait"
      ? {
          fontScale: 0.06,
          maximumCueDurationUs: 2_800_000,
          maximumGapUs: 600_000,
          maximumWordsPerCue: 7,
          safeBottomFraction: 0.17,
          widthFraction: 0.9,
        }
      : {
          fontScale: 0.052,
          maximumCueDurationUs: 3_100_000,
          maximumGapUs: 650_000,
          maximumWordsPerCue: 9,
          safeBottomFraction: 0.105,
          widthFraction: 0.9,
        };
  const fontSize = Math.max(1, Math.round(
    Math.min(output.pixelWidth, output.pixelHeight) * geometry.fontScale,
  ));
  const targetCardWidth = Math.max(1, Math.min(
    output.pixelWidth,
    Math.round(output.pixelWidth * geometry.widthFraction),
  ));
  const horizontalPadding = Math.max(0, Math.round(fontSize * 0.65));
  const usableWidth = Math.max(1, targetCardWidth - horizontalPadding * 2);
  const maximumLineUnits = Math.max(1, Math.floor(
    usableWidth * CAPTION_WIDTH_UNITS_PER_EM / fontSize,
  ));
  return {
    fontSize,
    maximumCueDurationUs: geometry.maximumCueDurationUs,
    maximumGapUs: geometry.maximumGapUs,
    maximumLineUnits,
    maximumTokenFragmentsPerCue:
      geometry.maximumWordsPerCue + MAXIMUM_ATTACHED_PUNCTUATION_FRAGMENTS,
    maximumWordsPerCue: geometry.maximumWordsPerCue,
    safeBottomFraction: geometry.safeBottomFraction,
    targetCardWidth,
  };
}

function intersection(left: SourceInterval, right: SourceInterval): SourceInterval | null {
  const startUs = Math.max(left.startUs, right.startUs);
  const endUs = Math.min(left.endUs, right.endUs);
  return endUs > startUs ? { endUs, startUs } : null;
}

function graphemeWidth(value: string): number {
  if (WHITESPACE_GRAPHEME.test(value)) return 350;
  if (EMOJI_OR_FLAG_GRAPHEME.test(value) || EAST_ASIAN_WIDE_GRAPHEME.test(value)) {
    return 1_100;
  }
  if (ASCII_WIDE_GRAPHEME.test(value)) return 1_000;
  if (ASCII_NARROW_GRAPHEME.test(value)) return 420;
  if (ASCII_UPPER_OR_DIGIT_GRAPHEME.test(value)) return 720;
  if (/^[\x20-\x7e]$/u.test(value)) return 620;

  // A grapheme in a shaped script can contain several joined letters. Count
  // those bases instead of assuming that every cluster occupies one Latin
  // average advance. SVG textLength then makes this deterministic estimate the
  // rendered advance, including when the renderer chooses a fallback font.
  const baseCount = [...value.matchAll(LETTER_OR_NUMBER)].length;
  return Math.max(850, Math.min(2_800, baseCount * 700));
}

function captionGraphemes(value: string): readonly CaptionGrapheme[] {
  return [...GRAPHEME_SEGMENTER.segment(value)].map(item => ({
    endIndex: item.index + item.segment.length,
    segment: item.segment,
    startIndex: item.index,
    widthUnits: graphemeWidth(item.segment),
  }));
}

function displayWidth(value: string): number {
  return captionGraphemes(value).reduce((width, grapheme) => width + grapheme.widthUnits, 0);
}

function lastGrapheme(value: string): string {
  return captionGraphemes(value).at(-1)?.segment ?? "";
}

function firstGrapheme(value: string): string {
  return captionGraphemes(value)[0]?.segment ?? "";
}

function straightQuoteCount(value: string, quote: "\"" | "'"): number {
  const characters = [...value];
  let count = 0;
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== quote) continue;
    if (
      quote === "'"
      && LETTER_OR_NUMBER_CHARACTER.test(characters[index - 1] ?? "")
      && LETTER_OR_NUMBER_CHARACTER.test(characters[index + 1] ?? "")
    ) {
      continue;
    }
    count += 1;
  }
  return count;
}

function straightQuoteCloses(previous: string, quote: "\"" | "'"): boolean {
  return straightQuoteCount(previous, quote) % 2 === 1;
}

function isClosingDelimiterToken(previous: string, current: string): boolean {
  if (!CLOSING_DELIMITER_TOKEN.test(current)) return false;
  let context = previous;
  for (const character of current) {
    if (
      (character === '"' || character === "'")
      && !straightQuoteCloses(context, character)
    ) {
      return false;
    }
    context += character;
  }
  return true;
}

function needsTokenSpace(previous: string, current: string): boolean {
  if (NO_SPACE_BEFORE.test(current) || NO_SPACE_AFTER.test(previous) || CONTRACTION_SUFFIX.test(current)) {
    return false;
  }
  const previousEnd = lastGrapheme(previous);
  const currentStart = firstGrapheme(current);
  if (
    (currentStart === '"' || currentStart === "'")
    && straightQuoteCloses(previous, currentStart)
  ) {
    return false;
  }
  if (
    (previousEnd === '"' || previousEnd === "'")
    && straightQuoteCount(previous, previousEnd) % 2 === 1
  ) {
    return false;
  }
  return !(CJK_WITHOUT_WORD_SPACES.test(previousEnd) && CJK_WITHOUT_WORD_SPACES.test(currentStart));
}

function joinedTokens(tokens: readonly MappedCaptionToken[]): string {
  let text = "";
  for (const token of tokens) {
    if (text.length === 0) {
      text = token.text;
    } else {
      text += `${needsTokenSpace(text, token.text) ? " " : ""}${token.text}`;
    }
  }
  return text;
}

function isNaturalLineBreak(leftGrapheme: string, rightGrapheme: string): boolean {
  return /\s$/u.test(leftGrapheme)
    || /^\s/u.test(rightGrapheme)
    || (
      CJK_WITHOUT_WORD_SPACES.test(leftGrapheme)
      && CJK_WITHOUT_WORD_SPACES.test(rightGrapheme)
    );
}

function wrapCaptionText(text: string, maximumLineUnits: number): ProjectCaptionLines | null {
  const segments = captionGraphemes(text);
  const prefixWidths = new Array<number>(segments.length + 1).fill(0);
  const lastNonWhitespace = new Array<number>(segments.length + 1).fill(0);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    prefixWidths[index + 1] = prefixWidths[index]! + segment.widthUnits;
    lastNonWhitespace[index + 1] = WHITESPACE_GRAPHEME.test(segment.segment)
      ? lastNonWhitespace[index]!
      : index + 1;
  }
  const totalWidth = prefixWidths.at(-1) ?? 0;
  if (totalWidth <= maximumLineUnits) return [text];
  if (totalWidth > maximumLineUnits * 2) return null;

  const firstNonWhitespace = new Array<number>(segments.length + 1).fill(segments.length);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    firstNonWhitespace[index] = WHITESPACE_GRAPHEME.test(segments[index]!.segment)
      ? firstNonWhitespace[index + 1]!
      : index;
  }
  let best: {
    readonly imbalance: number;
    readonly leftEnd: number;
    readonly natural: boolean;
    readonly rightStart: number;
  } | null = null;
  for (let index = 1; index < segments.length; index += 1) {
    const leftEnd = lastNonWhitespace[index]!;
    const rightStart = firstNonWhitespace[index]!;
    if (leftEnd === 0 || rightStart === segments.length) continue;
    const leftWidth = prefixWidths[leftEnd]!;
    const rightWidth = totalWidth - prefixWidths[rightStart]!;
    if (leftWidth > maximumLineUnits || rightWidth > maximumLineUnits) continue;
    const natural = isNaturalLineBreak(
      segments[index - 1]!.segment,
      segments[index]!.segment,
    );
    const imbalance = Math.abs(leftWidth - rightWidth);
    if (
      best === null
      || (natural && !best.natural)
      || (natural === best.natural && imbalance < best.imbalance)
    ) {
      best = { imbalance, leftEnd, natural, rightStart };
    }
  }
  if (best === null) return null;
  return [
    text.slice(0, segments[best.leftEnd - 1]!.endIndex),
    text.slice(segments[best.rightStart]!.startIndex),
  ];
}

function normalizeToken(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function splitTextToFit(value: string, maximumLineUnits: number): readonly string[] {
  if (wrapCaptionText(value, maximumLineUnits) !== null) return [value];
  const chunks: string[] = [];
  let chunk = "";
  let width = 0;
  for (const grapheme of captionGraphemes(value)) {
    const nextWidth = grapheme.widthUnits;
    if (nextWidth > maximumLineUnits) {
      throw new RangeError("A transcript grapheme cannot fit within the caption line bound.");
    }
    if (chunk.length > 0 && width + nextWidth > maximumLineUnits) {
      const trimmed = chunk.trim();
      if (trimmed.length > 0) chunks.push(trimmed);
      chunk = "";
      width = 0;
    }
    chunk += grapheme.segment;
    width += nextWidth;
  }
  const trimmed = chunk.trim();
  if (trimmed.length > 0) chunks.push(trimmed);
  if (chunks.length === 0 || chunks.some(candidate => wrapCaptionText(candidate, maximumLineUnits) === null)) {
    throw new RangeError("A transcript token cannot fit within the two-line caption bound.");
  }
  return chunks;
}

function splitMappedToken(
  token: MappedCaptionToken,
  maximumLineUnits: number,
): readonly MappedCaptionToken[] {
  const chunks = splitTextToFit(token.text, maximumLineUnits);
  if (chunks.length === 1) return [token];
  const ranges = [token.assetRange, token.projectRange, token.outputRange];
  if (ranges.some(range => range.endUs - range.startUs < chunks.length)) {
    throw new RangeError(
      `Transcript word ${token.sourceWordIndex} is too short to split into bounded caption lines.`,
    );
  }
  const weights = chunks.map(chunk => Math.max(1, displayWidth(chunk)));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  let priorWeight = 0;
  return chunks.map((text, index) => {
    const nextWeight = priorWeight + weights[index]!;
    const rangeAt = (range: SourceInterval): SourceInterval => ({
      endUs: interpolateMicroseconds(
        nextWeight,
        0,
        totalWeight,
        range.startUs,
        range.endUs,
      ),
      startUs: interpolateMicroseconds(
        priorWeight,
        0,
        totalWeight,
        range.startUs,
        range.endUs,
      ),
    });
    const output: MappedCaptionToken = {
      ...token,
      assetRange: rangeAt(token.assetRange),
      mappingKey: `${token.mappingKey}:token-part-${index}`,
      outputRange: rangeAt(token.outputRange),
      projectRange: rangeAt(token.projectRange),
      text,
    };
    priorWeight = nextWeight;
    if (
      output.assetRange.endUs <= output.assetRange.startUs
      || output.projectRange.endUs <= output.projectRange.startUs
      || output.outputRange.endUs <= output.outputRange.startUs
    ) {
      throw new RangeError(
        `Transcript word ${token.sourceWordIndex} collapsed while splitting bounded caption lines.`,
      );
    }
    return output;
  });
}

function firstSyncSegmentEndingAfter(
  segments: readonly ProjectSyncSegment[],
  assetTimeUs: number,
): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (segments[middle]!.asset.endUs <= assetTimeUs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstOutputSegmentEndingAfter(
  segments: readonly ProjectOutputSegment[],
  projectTimeUs: number,
): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (segments[middle]!.project.endUs <= projectTimeUs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function* mappedWordTokens(input: {
  readonly maximumLineUnits: number;
  readonly outputSegments: readonly ProjectOutputSegment[];
  readonly syncSegments: readonly ProjectSyncSegment[];
  readonly word: Extract<SpeechAnalysisV1["result"], { readonly status: "transcribed" }>["words"][number];
}): Generator<MappedCaptionToken, void> {
  const text = normalizeToken(input.word.text);
  if (text.length === 0) return;
  for (
    let syncIndex = firstSyncSegmentEndingAfter(input.syncSegments, input.word.range.startUs);
    syncIndex < input.syncSegments.length;
    syncIndex += 1
  ) {
    const sync = input.syncSegments[syncIndex]!;
    if (sync.asset.startUs >= input.word.range.endUs) break;
    const assetRange = intersection(input.word.range, sync.asset);
    if (assetRange === null) continue;
    const mappedProjectRange = {
      endUs: interpolateMicroseconds(
        assetRange.endUs,
        sync.asset.startUs,
        sync.asset.endUs,
        sync.project.startUs,
        sync.project.endUs,
      ),
      startUs: interpolateMicroseconds(
        assetRange.startUs,
        sync.asset.startUs,
        sync.asset.endUs,
        sync.project.startUs,
        sync.project.endUs,
      ),
    };
    if (mappedProjectRange.endUs <= mappedProjectRange.startUs) continue;
    for (
      let outputIndex = firstOutputSegmentEndingAfter(
        input.outputSegments,
        mappedProjectRange.startUs,
      );
      outputIndex < input.outputSegments.length;
      outputIndex += 1
    ) {
      const outputSegment = input.outputSegments[outputIndex]!;
      if (outputSegment.project.startUs >= mappedProjectRange.endUs) break;
      const projectRange = intersection(mappedProjectRange, outputSegment.project);
      if (projectRange === null) continue;
      const fragmentAssetRange = {
        endUs: interpolateMicroseconds(
          projectRange.endUs,
          sync.project.startUs,
          sync.project.endUs,
          sync.asset.startUs,
          sync.asset.endUs,
        ),
        startUs: interpolateMicroseconds(
          projectRange.startUs,
          sync.project.startUs,
          sync.project.endUs,
          sync.asset.startUs,
          sync.asset.endUs,
        ),
      };
      const outputRange = {
        endUs: interpolateMicroseconds(
          projectRange.endUs,
          outputSegment.project.startUs,
          outputSegment.project.endUs,
          outputSegment.output.startUs,
          outputSegment.output.endUs,
        ),
        startUs: interpolateMicroseconds(
          projectRange.startUs,
          outputSegment.project.startUs,
          outputSegment.project.endUs,
          outputSegment.output.startUs,
          outputSegment.output.endUs,
        ),
      };
      if (
        fragmentAssetRange.endUs <= fragmentAssetRange.startUs
        || outputRange.endUs <= outputRange.startUs
      ) {
        continue;
      }
      yield* splitMappedToken({
        assetRange: fragmentAssetRange,
        mappingKey: `${syncIndex}:${outputIndex}`,
        outputRange,
        projectRange,
        sourceWordIndex: input.word.wordIndex,
        speaker: input.word.speaker,
        text,
      }, input.maximumLineUnits);
    }
  }
}

function assertCurrentCaptionInputs(
  project: VideoProjectV1,
  plan: ProjectEditPlanV1,
  analysis: SpeechAnalysisV1,
  placementId: string,
): {
  readonly placement: VideoProjectV1["placements"][number];
  readonly words: Extract<SpeechAnalysisV1["result"], { readonly status: "transcribed" }>["words"];
} {
  if (plan.projectId !== project.projectId) {
    throw new TypeError("Caption edit plan belongs to another project.");
  }
  if (
    plan.timelineDurationUs !== project.timeline.durationUs
    || plan.projectStructureSha256 !== hashProjectStructure(project)
  ) {
    throw new TypeError("Caption project and edit plan are stale or contradictory.");
  }
  const placement = project.placements.find(candidate => candidate.placementId === placementId);
  if (placement === undefined) {
    throw new TypeError(`Caption placement ${placementId} does not exist in the project.`);
  }
  if (!placement.enabled) {
    throw new TypeError(`Caption placement ${placementId} is disabled.`);
  }
  if (analysis.subject.assetId !== placement.assetId) {
    throw new TypeError("Caption speech analysis does not match the selected placement asset.");
  }
  const configured = placement.audio.find(candidate => candidate.streamId === analysis.subject.streamId);
  if (configured?.presentation.enabled !== true) {
    throw new TypeError("Caption speech stream is not audibly enabled on the selected placement.");
  }
  const asset = project.assets.find(candidate => candidate.assetId === placement.assetId);
  const stream = asset?.streams.find(candidate => candidate.streamId === analysis.subject.streamId);
  if (asset === undefined || stream?.kind !== "audio") {
    throw new TypeError("Caption speech analysis does not identify a current project audio stream.");
  }
  const expectedSubjectIntegrity = canonicalJsonSha256({
    assetDurationUs: asset.durationUs,
    stream,
  });
  if (
    analysis.durationUs !== asset.durationUs
    || analysis.subject.integritySha256 !== expectedSubjectIntegrity
  ) {
    throw new TypeError("Caption speech analysis is stale for the current audio stream.");
  }
  const reference = project.analyses.find(candidate => candidate.analysisId === analysis.analysisId);
  if (reference === undefined || reference.kind !== "speech") {
    throw new TypeError("Caption speech analysis is not registered by the current project.");
  }
  const wordCount = analysis.result.status === "transcribed" ? analysis.result.words.length : 0;
  const fillerCount = analysis.result.status === "transcribed" ? analysis.result.fillers.length : 0;
  if (
    reference.assetId !== analysis.subject.assetId
    || reference.streamId !== analysis.subject.streamId
    || reference.createdAt !== analysis.createdAt
    || reference.wordCount !== wordCount
    || reference.fillerCount !== fillerCount
    || reference.sha256 !== sha256Hex(`${canonicalJson(analysis)}\n`)
  ) {
    throw new TypeError("Caption speech analysis contradicts its current project reference.");
  }
  if (analysis.result.status === "no-speech") {
    throw new TypeError("Caption speech analysis contains no speech.");
  }
  return { placement, words: analysis.result.words };
}

function sourceIndices(tokens: readonly MappedCaptionToken[]): readonly number[] {
  const output: number[] = [];
  for (const token of tokens) {
    if (output.at(-1) !== token.sourceWordIndex) output.push(token.sourceWordIndex);
  }
  return output;
}

function canAppendToken(
  tokens: readonly MappedCaptionToken[],
  next: MappedCaptionToken,
  profile: CaptionProfile,
): boolean {
  const previous = tokens.at(-1);
  const first = tokens[0];
  if (previous === undefined || first === undefined) return true;
  if (tokens.length >= profile.maximumTokenFragmentsPerCue) return false;
  if (
    previous.mappingKey !== next.mappingKey
    || next.sourceWordIndex !== previous.sourceWordIndex + 1
    || previous.speaker !== next.speaker
    || next.outputRange.startUs < previous.outputRange.endUs
    || next.projectRange.startUs < previous.projectRange.endUs
    || next.outputRange.startUs - previous.outputRange.endUs > profile.maximumGapUs
  ) {
    return false;
  }
  const pendingText = joinedTokens(tokens);
  if (
    CUE_ENDING_PUNCTUATION.test(pendingText)
    && !isClosingDelimiterToken(pendingText, next.text)
  ) {
    return false;
  }
  const attachesPunctuation = PUNCTUATION_TOKEN.test(next.text)
    && !needsTokenSpace(pendingText, next.text);
  if (
    sourceIndices([...tokens, next]).length > profile.maximumWordsPerCue
    && !attachesPunctuation
  ) {
    return false;
  }
  if (next.outputRange.endUs - first.outputRange.startUs > profile.maximumCueDurationUs) return false;
  return wrapCaptionText(joinedTokens([...tokens, next]), profile.maximumLineUnits) !== null;
}

function cueFromTokens(
  tokens: readonly MappedCaptionToken[],
  profile: CaptionProfile,
): ProjectCaptionCue {
  const first = tokens[0];
  const last = tokens.at(-1);
  if (first === undefined || last === undefined) {
    throw new TypeError("Cannot build an empty project caption cue.");
  }
  const lines = wrapCaptionText(joinedTokens(tokens), profile.maximumLineUnits);
  if (lines === null) throw new RangeError("Project caption cue exceeds its two-line width bound.");
  return {
    lines,
    outputRange: {
      endUs: last.outputRange.endUs,
      startUs: first.outputRange.startUs,
    },
    projectRange: {
      endUs: last.projectRange.endUs,
      startUs: first.projectRange.startUs,
    },
    sourceWordIndices: sourceIndices(tokens),
  };
}

function assertCueLaws(cues: readonly ProjectCaptionCue[]): void {
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index]!;
    if (
      cue.outputRange.endUs <= cue.outputRange.startUs
      || cue.projectRange.endUs <= cue.projectRange.startUs
      || cue.lines.length < 1
      || cue.lines.length > 2
      || cue.lines.some(line => line.length === 0)
      || cue.sourceWordIndices.length === 0
    ) {
      throw new TypeError(`Compiled caption cue ${index} is empty or inverted.`);
    }
    const previous = cues[index - 1];
    if (previous !== undefined && (
      cue.outputRange.startUs < previous.outputRange.endUs
      || cue.projectRange.startUs < previous.projectRange.endUs
    )) {
      throw new TypeError("Compiled caption cues must be ordered and non-overlapping.");
    }
  }
}

/**
 * Compile one current word transcript through placement synchronization and
 * the project's cut/speed output map. The result is pure and output-clock
 * ready; each cue keeps exact project-clock and source-word provenance.
 */
export function compileProjectCaptionCues(
  input: CompileProjectCaptionCuesInput,
): readonly ProjectCaptionCue[] {
  const project = VideoProjectV1Schema.parse(input.project);
  const plan = ProjectEditPlanV1Schema.parse(input.plan);
  const analysis = SpeechAnalysisV1Schema.parse(input.analysis);
  const profile = captionProfile(input.output);
  const { placement, words } = assertCurrentCaptionInputs(
    project,
    plan,
    analysis,
    input.placementId,
  );
  const outputMap = buildProjectOutputTimeMap(plan);
  if (
    input.output.durationUs !== undefined
    && input.output.durationUs !== outputMap.durationUs
  ) {
    throw new TypeError("Caption output duration contradicts the project cut/speed map.");
  }
  const syncSegments = projectSyncSegments(placement.sync);
  const cues: ProjectCaptionCue[] = [];
  let pending: MappedCaptionToken[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    cues.push(cueFromTokens(pending, profile));
    pending = [];
    if (cues.length > PROJECT_CAPTION_LIMITS.maximumVisibleCues) {
      throw new RangeError(
        `Visible transcript exceeds the ${PROJECT_CAPTION_LIMITS.maximumVisibleCues}-cue caption bound.`,
      );
    }
  };
  let visibleWordCount = 0;
  for (const word of words) {
    let wordIsVisible = false;
    for (const token of mappedWordTokens({
      maximumLineUnits: profile.maximumLineUnits,
      outputSegments: outputMap.segments,
      syncSegments,
      word,
    })) {
      if (!wordIsVisible) {
        wordIsVisible = true;
        visibleWordCount += 1;
        if (visibleWordCount > PROJECT_CAPTION_LIMITS.maximumVisibleWords) {
          throw new RangeError(
            `Visible transcript exceeds the ${PROJECT_CAPTION_LIMITS.maximumVisibleWords}-word caption bound.`,
          );
        }
      }
      if (!canAppendToken(pending, token, profile)) flush();
      pending.push(token);
    }
  }
  if (visibleWordCount === 0) {
    throw new TypeError("Caption compilation produced no visible transcript after project edits.");
  }
  flush();
  assertCueLaws(cues);
  return cues;
}

function xmlSafeText(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const invalid = (
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      || (codePoint & 0xffff) === 0xfffe
      || (codePoint & 0xffff) === 0xffff
      || codePoint > 0x10ffff
    );
    safe += invalid ? "\ufffd" : character;
  }
  return safe
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Render one already-wrapped cue as a transparent, intrinsic-size SVG card. */
export function renderSocialCaptionSvg(
  cue: ProjectCaptionCue,
  output: ProjectCaptionOutput,
): SocialCaptionSvg {
  const profile = captionProfile(output);
  if (
    (cue.lines.length !== 1 && cue.lines.length !== 2)
    || cue.lines.some(line => typeof line !== "string" || line.length === 0)
  ) {
    throw new TypeError("Social caption SVG requires one or two nonempty wrapped lines.");
  }
  if (cue.lines.some(line => displayWidth(line) > profile.maximumLineUnits)) {
    throw new RangeError("Social caption SVG line exceeds the selected output width bound.");
  }
  const horizontalPadding = Math.max(0, Math.round(profile.fontSize * 0.65));
  const verticalPadding = Math.max(0, Math.round(profile.fontSize * 0.38));
  const lineHeight = Math.max(1, Math.round(profile.fontSize * 1.18));
  const lineTextWidths = cue.lines.map(line => Math.max(
    1,
    Math.ceil(displayWidth(line) * profile.fontSize / CAPTION_WIDTH_UNITS_PER_EM),
  ));
  const estimatedTextWidth = Math.max(...lineTextWidths);
  const intrinsicWidth = Math.max(1, Math.min(
    profile.targetCardWidth,
    Math.max(
      Math.min(profile.targetCardWidth, profile.fontSize * 4),
      estimatedTextWidth + horizontalPadding * 2,
    ),
  ));
  const intrinsicHeight = Math.max(1, Math.min(
    output.pixelHeight,
    verticalPadding * 2 + lineHeight * cue.lines.length,
  ));
  const bottomSafeMargin = Math.max(0, Math.min(
    output.pixelHeight - intrinsicHeight,
    Math.round(output.pixelHeight * profile.safeBottomFraction),
  ));
  const radius = Math.max(1, Math.round(profile.fontSize * 0.34));
  const strokeWidth = Math.max(1, Math.round(profile.fontSize * 0.055));
  const textStrokeWidth = Math.max(1, Math.round(profile.fontSize * 0.045));
  const centerX = intrinsicWidth / 2;
  const blockHeight = lineHeight * cue.lines.length;
  const firstBaseline = Math.round(
    (intrinsicHeight - blockHeight) / 2 + profile.fontSize * 0.84,
  );
  const text = cue.lines.map((line, index) => (
    `<tspan x="${centerX}" y="${firstBaseline + index * lineHeight}" textLength="${lineTextWidths[index]}" lengthAdjust="spacingAndGlyphs">${xmlSafeText(line)}</tspan>`
  )).join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${intrinsicWidth}" height="${intrinsicHeight}" viewBox="0 0 ${intrinsicWidth} ${intrinsicHeight}" fill="none">`,
    `<rect x="${strokeWidth / 2}" y="${strokeWidth / 2}" width="${Math.max(0, intrinsicWidth - strokeWidth)}" height="${Math.max(0, intrinsicHeight - strokeWidth)}" rx="${radius}" fill="#050505" fill-opacity="0.9" stroke="#ffffff" stroke-opacity="0.2" stroke-width="${strokeWidth}"/>`,
    `<text fill="#ffffff" stroke="#000000" stroke-opacity="0.72" stroke-width="${textStrokeWidth}" paint-order="stroke fill" font-family="Nebula Sans" font-size="${profile.fontSize}" font-weight="700" text-anchor="middle">${text}</text>`,
    "</svg>",
  ].join("");
  return { bottomSafeMargin, intrinsicHeight, intrinsicWidth, svg };
}
