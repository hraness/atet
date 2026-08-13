import { describe, expect, test } from "bun:test";

import { AnalysisSubjectSchema } from "../contracts/analysis";
import {
  analyzeSpeech,
  classifyFillerWords,
  type AnalyzeSpeechInput,
  type SpeechWordInput,
} from "./speech-analysis";

const SHA = "c".repeat(64);

function word(text: string, startUs: number, endUs: number, confidence = 1): SpeechWordInput {
  return { confidence, range: { endUs, startUs }, speaker: "speaker-1", text };
}

function input(words: readonly SpeechWordInput[]): AnalyzeSpeechInput {
  return {
    analysisId: "analysis_speech0001",
    config: { language: "en", minimumFillerConfidence: 0.7, speechHandleUs: 100_000 },
    createdAt: "2026-07-22T12:00:00.000Z",
    detectedLanguage: "en",
    durationUs: 4_000_000,
    inputDigest: SHA,
    subject: AnalysisSubjectSchema.parse({
      assetId: "asset_speech00001",
      integritySha256: SHA,
      streamId: "stream_speech00001",
    }),
    tool: { name: "studio", profile: "owned-transcript-v1", version: "0.1.0" },
    words,
  };
}

const EXAMPLE_WORDS = [
  word("Today", 0, 200_000),
  word("um", 500_000, 600_000),
  word("you", 900_000, 980_000),
  word("know", 1_000_000, 1_100_000),
  word("like", 1_400_000, 1_500_000),
  word("the", 1_800_000, 1_900_000),
  word("the", 2_200_000, 2_300_000),
  word("inter-", 2_600_000, 2_700_000),
  word("works", 3_000_000, 3_100_000),
] as const;

describe("speech analysis", () => {
  test("classifies filled pauses, phrase fillers, contextual like, repetitions, and false starts", () => {
    expect(classifyFillerWords(EXAMPLE_WORDS)).toEqual([
      { classification: "filled-pause", lexicalConfidence: 0.99, wordEndExclusive: 2, wordStart: 1 },
      { classification: "phrase-filler", lexicalConfidence: 0.97, wordEndExclusive: 4, wordStart: 2 },
      { classification: "contextual", lexicalConfidence: 0.82, wordEndExclusive: 5, wordStart: 4 },
      { classification: "repetition", lexicalConfidence: 0.96, wordEndExclusive: 7, wordStart: 6 },
      { classification: "false-start", lexicalConfidence: 0.94, wordEndExclusive: 8, wordStart: 7 },
    ]);
  });

  test("makes strong isolated fillers auto-applicable but never contextual like", () => {
    const analysis = analyzeSpeech(input(EXAMPLE_WORDS));
    if (analysis.result.status !== "transcribed") throw new Error("Expected a transcript.");
    const filledPause = analysis.result.fillers.find(filler => filler.classification === "filled-pause");
    const contextual = analysis.result.fillers.find(filler => filler.text.toLocaleLowerCase("en-US") === "like");

    expect(filledPause).toMatchObject({
      acousticBoundaryConfidence: 1,
      autoApplicable: true,
      recommendedCut: { endUs: 700_000, startUs: 400_000 },
    });
    expect(contextual).toMatchObject({
      autoApplicable: false,
      classification: "contextual",
      recommendedCut: null,
    });
    expect(analysis.result.fillers.every((filler, index, fillers) =>
      index === 0 || filler.range.startUs >= fillers[index - 1]!.range.endUs)).toBe(true);
  });

  test("protects every filler that overlaps music", () => {
    const analysis = analyzeSpeech({
      ...input(EXAMPLE_WORDS),
      musicRegions: [{ confidence: 1, range: { endUs: 680_000, startUs: 650_000 } }],
    });
    if (analysis.result.status !== "transcribed") throw new Error("Expected a transcript.");
    const filler = analysis.result.fillers.find(candidate => candidate.classification === "filled-pause");
    expect(filler).toMatchObject({ autoApplicable: false, musicProtected: true, recommendedCut: null });
  });

  test("derives utterances and emits a schema-valid no-speech result", () => {
    const analysis = analyzeSpeech(input(EXAMPLE_WORDS));
    if (analysis.result.status !== "transcribed") throw new Error("Expected a transcript.");
    expect(analysis.result.words.map(item => item.wordIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(analysis.result.utterances).toHaveLength(1);
    expect(analysis.result.utterances[0]?.text).toBe("Today um you know like the the inter- works");

    const empty = analyzeSpeech(input([]));
    expect(empty.result).toEqual({ detectedLanguage: "en", reason: "no-speech", status: "no-speech" });
  });

  test("rejects overlapping transcript words instead of inventing an ordering", () => {
    expect(() => analyzeSpeech(input([
      word("one", 0, 200_000),
      word("two", 100_000, 300_000),
    ]))).toThrow("Transcript words must not overlap");
  });
});
