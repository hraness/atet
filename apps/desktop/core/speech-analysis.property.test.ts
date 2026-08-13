import { describe, expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import { TranscriptWordSchema } from "../contracts/analysis";
import {
  buildFillerCandidates,
  classifyFillerWords,
  mergeFillerSpans,
} from "./speech-analysis";

const tokenArbitrary = fc.constantFrom("um", "uh", "like", "you", "know", "word", "word", "start-");

describe("speech-analysis properties", () => {
  assertProperty(fc.property(fc.array(tokenArbitrary, { maxLength: 40 }), (tokens) => {
    const words = tokens.map((text, wordIndex) => TranscriptWordSchema.parse({
      confidence: 1,
      range: { endUs: wordIndex * 200_000 + 100_000, startUs: wordIndex * 200_000 },
      speaker: null,
      text,
      wordIndex,
    }));
    const durationUs = Math.max(1, tokens.length * 200_000 + 100_000);
    const candidates = buildFillerCandidates(
      words,
      { language: "en", minimumFillerConfidence: 0, speechHandleUs: 50_000 },
      durationUs,
      [{ range: { endUs: durationUs, startUs: 0 } }],
    );
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      expect(candidate.autoApplicable).toBe(false);
      expect(candidate.musicProtected).toBe(true);
      expect(candidate.recommendedCut).toBeNull();
      if (index > 0) expect(candidate.range.startUs).toBeGreaterThanOrEqual(candidates[index - 1]!.range.endUs);
    }
  }));

  assertProperty(fc.property(fc.array(tokenArbitrary, { maxLength: 40 }), (tokens) => {
    const classified = classifyFillerWords(tokens.map(text => ({ text })));
    expect(mergeFillerSpans(classified)).toEqual(classified);
    for (let index = 1; index < classified.length; index += 1) {
      expect(classified[index]!.wordStart).toBeGreaterThanOrEqual(classified[index - 1]!.wordEndExclusive);
    }
    for (const span of classified) {
      if (tokens.slice(span.wordStart, span.wordEndExclusive).some(token => token === "like")) {
        expect(span.classification).toBe("contextual");
      }
    }
  }));
});
