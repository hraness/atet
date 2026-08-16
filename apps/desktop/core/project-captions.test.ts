import { describe, expect, test } from "bun:test";

import {
  SpeechAnalysisV1Schema,
  type SpeechAnalysisV1,
} from "../contracts/analysis";
import { EditPlanIdSchema } from "../contracts/edit";
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
import {
  compileProjectCaptionCues,
  PROJECT_CAPTION_LIMITS,
  renderSocialCaptionSvg,
  type ProjectCaptionCue,
  type ProjectCaptionOutput,
} from "./project-captions";
import { createDefaultProjectEditPlan } from "./project-plan";
import { loadAnalysisArtifact } from "./storage";
import { buildProjectOutputTimeMap } from "./project-time";

const NOW = "2026-07-31T12:00:00.000Z";
const MEDIA_SHA256 = "a".repeat(64);
const SOURCE_SHA256 = "b".repeat(64);
const ANALYSIS_INPUT_SHA256 = "c".repeat(64);

interface TestWord {
  readonly endUs: number;
  readonly speaker?: string | null;
  readonly startUs: number;
  readonly text: string;
}

interface CaptionFixtureOptions {
  readonly audioEnabled?: boolean;
  readonly durationUs: number;
  readonly keep?: ProjectEditPlanV1["keep"];
  readonly noSpeech?: boolean;
  readonly output?: Pick<ProjectCaptionOutput, "pixelHeight" | "pixelWidth">;
  readonly placementEnabled?: boolean;
  readonly speed?: ProjectEditPlanV1["speed"];
  readonly syncAnchors?: VideoProjectV1["placements"][number]["sync"]["anchors"];
  readonly timelineDurationUs?: number;
  readonly words?: readonly TestWord[];
}

function captionFixture(options: CaptionFixtureOptions): {
  readonly analysis: SpeechAnalysisV1;
  readonly output: ProjectCaptionOutput;
  readonly plan: ProjectEditPlanV1;
  readonly project: VideoProjectV1;
} {
  const timelineDurationUs = options.timelineDurationUs ?? options.durationUs;
  const words = options.words ?? [];
  const stream = {
    channels: 2,
    kind: "audio" as const,
    label: "Dialogue",
    role: "dialogue" as const,
    sampleRateHz: 48_000,
    segments: [{
      assetRange: { endUs: options.durationUs, startUs: 0 },
      bytes: 4_096,
      codec: "pcm_s16le",
      container: "wav",
      fileRange: { endUs: options.durationUs, startUs: 0 },
      path: "artifacts/atet/projects/project_caption0001/dialogue.wav",
      sha256: MEDIA_SHA256,
      streamIndex: 0,
    }],
    streamId: "stream_caption0001",
  };
  const analysis = SpeechAnalysisV1Schema.parse({
    analysisId: "analysis_caption0001",
    config: {
      language: "en",
      minimumFillerConfidence: 0.7,
      speechHandleUs: 100_000,
    },
    createdAt: NOW,
    durationUs: options.durationUs,
    inputDigest: ANALYSIS_INPUT_SHA256,
    kind: "atet.speech-analysis",
    result: options.noSpeech
      ? {
          detectedLanguage: "en",
          reason: "no-speech",
          status: "no-speech",
        }
      : {
          detectedLanguage: "en",
          fillers: [],
          status: "transcribed",
          utterances: words.length === 0
            ? []
            : [{
                range: {
                  endUs: words.at(-1)!.endUs,
                  startUs: words[0]!.startUs,
                },
                text: "Test transcript",
                wordEndExclusive: words.length,
                wordStart: 0,
              }],
          words: words.map((word, wordIndex) => ({
            confidence: 1,
            range: { endUs: word.endUs, startUs: word.startUs },
            speaker: word.speaker === undefined ? "speaker-one" : word.speaker,
            text: word.text,
            wordIndex,
          })),
        },
    schemaVersion: 1,
    subject: {
      assetId: "asset_caption0001",
      integritySha256: canonicalJsonSha256({
        assetDurationUs: options.durationUs,
        stream,
      }),
      streamId: stream.streamId,
    },
    tool: {
      name: "caption-test",
      profile: "word-timestamps-v1",
      version: "1.0.0",
    },
  });
  const project = VideoProjectV1Schema.parse({
    analyses: [{
      analysisId: analysis.analysisId,
      assetId: analysis.subject.assetId,
      createdAt: analysis.createdAt,
      fillerCount: analysis.result.status === "transcribed" ? analysis.result.fillers.length : 0,
      kind: "speech",
      path: "artifacts/atet/projects/project_caption0001/analysis/speech.json",
      sha256: sha256Hex(`${canonicalJson(analysis)}\n`),
      streamId: analysis.subject.streamId,
      wordCount: analysis.result.status === "transcribed" ? analysis.result.words.length : 0,
    }],
    assets: [{
      assetId: "asset_caption0001",
      createdAt: NOW,
      durationUs: options.durationUs,
      label: "Caption dialogue",
      role: "dialogue",
      source: {
        generator: "caption-test",
        generatorVersion: "1.0.0",
        kind: "generated",
        sourceSha256: SOURCE_SHA256,
      },
      streams: [stream],
    }],
    createdAt: NOW,
    currentEditPlanPath: null,
    kind: "atet.video-project",
    name: "Caption test project",
    placements: [{
      assetId: "asset_caption0001",
      assetRange: { endUs: options.durationUs, startUs: 0 },
      audio: [{
        presentation: options.audioEnabled === false
          ? { enabled: false }
          : { enabled: true, gainDb: 0, pan: 0 },
        streamId: stream.streamId,
      }],
      enabled: options.placementEnabled !== false,
      placementId: "placement_caption0001",
      sync: {
        anchors: options.syncAnchors ?? [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: options.durationUs, projectTimeUs: timelineDurationUs },
        ],
        provenance: options.syncAnchors === undefined
          ? { kind: "identity" }
          : { kind: "manual", note: "Explicit drift map" },
      },
      video: [],
    }],
    projectId: "project_caption0001",
    referencePlacementId: "placement_caption0001",
    schemaVersion: 1,
    timeline: { durationUs: timelineDurationUs, timebase: "microseconds" },
    updatedAt: NOW,
  });
  const basePlan = createDefaultProjectEditPlan(
    project,
    EditPlanIdSchema.parse("plan_caption0001"),
    NOW,
  );
  const plan = ProjectEditPlanV1Schema.parse({
    ...basePlan,
    keep: options.keep ?? basePlan.keep,
    speed: options.speed ?? [],
  });
  const dimensions = options.output ?? { pixelHeight: 1_920, pixelWidth: 1_080 };
  return {
    analysis,
    output: {
      ...dimensions,
      durationUs: buildProjectOutputTimeMap(plan).durationUs,
    },
    plan,
    project,
  };
}

function compile(fixture: ReturnType<typeof captionFixture>) {
  return compileProjectCaptionCues({
    ...fixture,
    placementId: "placement_caption0001",
  });
}

describe("project caption timing", () => {
  test("verifies and consumes a predecessor speech artifact without rewriting its hashed identity", async () => {
    const fixture = captionFixture({
      durationUs: 1_000_000,
      words: [{ endUs: 500_000, startUs: 100_000, text: "Light" }],
    });
    const predecessor = SpeechAnalysisV1Schema.parse({
      ...fixture.analysis,
      kind: "studio.speech-analysis",
    });
    const contents = `${canonicalJson(predecessor)}\n`;
    const loaded = SpeechAnalysisV1Schema.parse(await loadAnalysisArtifact({
      readText: async () => contents,
      writeTextAtomic: async () => {
        throw new Error("The immutable predecessor fixture must not be rewritten.");
      },
    }, "analysis/speech.json"));
    const project = VideoProjectV1Schema.parse({
      ...fixture.project,
      analyses: fixture.project.analyses.map(reference => ({
        ...reference,
        sha256: sha256Hex(contents),
      })),
    });

    expect(loaded.kind).toBe("studio.speech-analysis");
    expect(compile({ ...fixture, analysis: loaded, project })[0]?.lines).toEqual(["Light"]);
  });

  test("maps words through a project cut and speed change", () => {
    const fixture = captionFixture({
      durationUs: 6_000_000,
      keep: [
        { endUs: 1_500_000, startUs: 0 },
        { endUs: 6_000_000, startUs: 2_000_000 },
      ],
      speed: [{
        range: { endUs: 5_000_000, startUs: 3_000_000 },
        rate: 2,
      }],
      words: [
        { endUs: 1_300_000, startUs: 1_000_000, text: "First" },
        { endUs: 1_800_000, startUs: 1_600_000, text: "hidden" },
        { endUs: 2_500_000, startUs: 2_200_000, text: "second" },
        { endUs: 3_600_000, startUs: 3_200_000, text: "fast" },
        { endUs: 5_500_000, startUs: 5_200_000, text: "last" },
      ],
    });

    expect(compile(fixture).map(cue => ({
      outputRange: cue.outputRange,
      projectRange: cue.projectRange,
      sourceWordIndices: cue.sourceWordIndices,
      text: cue.lines.join(" "),
    }))).toEqual([
      {
        outputRange: { endUs: 1_300_000, startUs: 1_000_000 },
        projectRange: { endUs: 1_300_000, startUs: 1_000_000 },
        sourceWordIndices: [0],
        text: "First",
      },
      {
        outputRange: { endUs: 2_000_000, startUs: 1_700_000 },
        projectRange: { endUs: 2_500_000, startUs: 2_200_000 },
        sourceWordIndices: [2],
        text: "second",
      },
      {
        outputRange: { endUs: 2_800_000, startUs: 2_600_000 },
        projectRange: { endUs: 3_600_000, startUs: 3_200_000 },
        sourceWordIndices: [3],
        text: "fast",
      },
      {
        outputRange: { endUs: 4_000_000, startUs: 3_700_000 },
        projectRange: { endUs: 5_500_000, startUs: 5_200_000 },
        sourceWordIndices: [4],
        text: "last",
      },
    ]);
  });

  test("splits a word at an explicit placement drift boundary", () => {
    const fixture = captionFixture({
      durationUs: 4_000_000,
      syncAnchors: [
        { assetTimeUs: 0, projectTimeUs: 0 },
        { assetTimeUs: 2_000_000, projectTimeUs: 2_200_000 },
        { assetTimeUs: 4_000_000, projectTimeUs: 4_000_000 },
      ],
      words: [{ endUs: 2_200_000, startUs: 1_800_000, text: "boundary" }],
    });

    expect(compile(fixture).map(cue => ({
      outputRange: cue.outputRange,
      projectRange: cue.projectRange,
      sourceWordIndices: cue.sourceWordIndices,
      text: cue.lines.join(" "),
    }))).toEqual([
      {
        outputRange: { endUs: 2_200_000, startUs: 1_980_000 },
        projectRange: { endUs: 2_200_000, startUs: 1_980_000 },
        sourceWordIndices: [0],
        text: "boundary",
      },
      {
        outputRange: { endUs: 2_380_000, startUs: 2_200_000 },
        projectRange: { endUs: 2_380_000, startUs: 2_200_000 },
        sourceWordIndices: [0],
        text: "boundary",
      },
    ]);
  });

  test("keeps every cue ordered, disjoint, bounded, and source-provenanced", () => {
    const words = Array.from({ length: 30 }, (_, index): TestWord => ({
      endUs: index * 180_000 + 100_000,
      speaker: index < 15 ? "speaker-one" : "speaker-two",
      startUs: index * 180_000,
      text: index % 7 === 6 ? `word${index}.` : `word${index}`,
    }));
    const fixture = captionFixture({
      durationUs: 6_000_000,
      keep: [
        { endUs: 2_000_000, startUs: 0 },
        { endUs: 6_000_000, startUs: 2_500_000 },
      ],
      speed: [{
        range: { endUs: 4_000_000, startUs: 3_000_000 },
        rate: 1.5,
      }],
      words,
    });
    const cues = compile(fixture);

    expect(cues.length).toBeGreaterThan(1);
    for (const [index, cue] of cues.entries()) {
      expect(cue.lines.length).toBeGreaterThanOrEqual(1);
      expect(cue.lines.length).toBeLessThanOrEqual(2);
      expect(cue.outputRange.endUs).toBeGreaterThan(cue.outputRange.startUs);
      expect(cue.projectRange.endUs).toBeGreaterThan(cue.projectRange.startUs);
      expect(cue.sourceWordIndices.every(wordIndex => words[wordIndex] !== undefined)).toBe(true);
      expect(cue.sourceWordIndices.every((wordIndex, sourceIndex, indices) => (
        sourceIndex === 0 || wordIndex > indices[sourceIndex - 1]!
      ))).toBe(true);
      const previous = cues[index - 1];
      if (previous === undefined) continue;
      expect(cue.outputRange.startUs).toBeGreaterThanOrEqual(previous.outputRange.endUs);
      expect(cue.projectRange.startUs).toBeGreaterThanOrEqual(previous.projectRange.endUs);
    }
  });
});

describe("project caption text layout", () => {
  test("groups short words, wraps at two lines, and starts a new cue after punctuation", () => {
    const fixture = captionFixture({
      durationUs: 3_000_000,
      words: [
        { endUs: 300_000, startUs: 0, text: "Build" },
        { endUs: 550_000, startUs: 320_000, text: "small" },
        { endUs: 850_000, startUs: 570_000, text: "things" },
        { endUs: 1_200_000, startUs: 870_000, text: "carefully" },
        { endUs: 1_230_000, startUs: 1_210_000, text: "." },
        { endUs: 1_550_000, startUs: 1_300_000, text: "Next" },
      ],
    });
    const cues = compile(fixture);

    expect(cues).toHaveLength(2);
    expect(cues[0]?.lines).toHaveLength(2);
    expect(cues[0]?.lines.join(" ")).toBe("Build small things carefully.");
    expect(cues[0]?.sourceWordIndices).toEqual([0, 1, 2, 3, 4]);
    expect(cues[1]?.lines).toEqual(["Next"]);
  });

  test("joins CJK tokens without invented spaces", () => {
    const fixture = captionFixture({
      durationUs: 1_000_000,
      words: [
        { endUs: 200_000, startUs: 0, text: "今" },
        { endUs: 400_000, startUs: 210_000, text: "天" },
        { endUs: 420_000, startUs: 410_000, text: "。" },
      ],
    });
    expect(compile(fixture)[0]?.lines.join("")).toBe("今天。");
  });

  test("attaches tokenized closing quotes and parentheses before ending a sentence cue", () => {
    const cases = [
      { expected: "“Hello.”", tokens: ["“", "Hello", ".", "”", "Next"] },
      { expected: '"Hello."', tokens: ['"', "Hello", ".", '"', "Next"] },
      { expected: "(Hello.)", tokens: ["(", "Hello", ".", ")", "Next"] },
    ] as const;

    for (const scenario of cases) {
      const fixture = captionFixture({
        durationUs: 1_000_000,
        words: scenario.tokens.map((text, index) => ({
          endUs: index * 100_000 + 80_000,
          startUs: index * 100_000,
          text,
        })),
      });
      const cues = compile(fixture);
      expect(cues).toHaveLength(2);
      expect(cues[0]?.lines.join(" ")).toBe(scenario.expected);
      expect(cues[1]?.lines).toEqual(["Next"]);
    }
  });

  test("uses straight-quote context to space an opening quote and close it without spaces", () => {
    const fixture = captionFixture({
      durationUs: 1_000_000,
      words: ["He", "said", '"', "hello", '"'].map((text, index) => ({
        endUs: index * 100_000 + 80_000,
        startUs: index * 100_000,
        text,
      })),
    });

    expect(compile(fixture)[0]?.lines.join(" ")).toBe('He said "hello"');
  });

  test("treats a straight quote after a completed sentence as the next opening quote", () => {
    const fixture = captionFixture({
      durationUs: 1_000_000,
      words: ["He", "said", ".", '"', "Hello", ".", '"'].map((text, index) => ({
        endUs: index * 100_000 + 80_000,
        startUs: index * 100_000,
        text,
      })),
    });

    expect(compile(fixture).map(cue => cue.lines.join(" "))).toEqual([
      "He said.",
      '"Hello."',
    ]);
  });

  test("escapes arbitrary transcript text into valid XML-safe SVG text", () => {
    const cue: ProjectCaptionCue = {
      lines: ['5 < 7 & "yes"', "it's \u0001 \ud83d\ude00"],
      outputRange: { endUs: 1_000_000, startUs: 0 },
      projectRange: { endUs: 1_000_000, startUs: 0 },
      sourceWordIndices: [0],
    };
    const card = renderSocialCaptionSvg(cue, {
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });

    expect(card.svg).toContain("5 &lt; 7 &amp; &quot;yes&quot;");
    expect(card.svg).toContain("it&apos;s \ufffd \ud83d\ude00");
    expect(card.svg).not.toContain("\u0001");
    expect(card.svg).toContain('fill="#050505"');
    expect(card.svg).toContain('fill="#ffffff"');
  });

  test("adapts card size and bottom safety for landscape, square/feed, and portrait", () => {
    const cue: ProjectCaptionCue = {
      lines: ["Safe caption"],
      outputRange: { endUs: 1_000_000, startUs: 0 },
      projectRange: { endUs: 1_000_000, startUs: 0 },
      sourceWordIndices: [0, 1],
    };
    const landscape = renderSocialCaptionSvg(cue, { pixelHeight: 1_080, pixelWidth: 1_920 });
    const square = renderSocialCaptionSvg(cue, { pixelHeight: 1_080, pixelWidth: 1_080 });
    const portrait = renderSocialCaptionSvg(cue, { pixelHeight: 1_920, pixelWidth: 1_080 });

    expect(portrait.bottomSafeMargin / 1_920).toBeGreaterThan(square.bottomSafeMargin / 1_080);
    expect(square.bottomSafeMargin / 1_080).toBeGreaterThan(landscape.bottomSafeMargin / 1_080);
    expect(portrait.intrinsicWidth / 1_080).toBeGreaterThan(landscape.intrinsicWidth / 1_920);
    expect(new Set([
      landscape.svg.match(/font-size="(\d+)"/u)?.[1],
      square.svg.match(/font-size="(\d+)"/u)?.[1],
      portrait.svg.match(/font-size="(\d+)"/u)?.[1],
    ]).size).toBeGreaterThan(1);
  });

  test("constrains wide Latin, fullwidth, flag, and shaped-script advances in SVG", () => {
    const renderLine = (line: string) => renderSocialCaptionSvg({
      lines: [line],
      outputRange: { endUs: 1_000_000, startUs: 0 },
      projectRange: { endUs: 1_000_000, startUs: 0 },
      sourceWordIndices: [0],
    }, { pixelHeight: 1_920, pixelWidth: 1_080 });
    const narrow = renderLine("iiiiiiiiii");
    const cards = [
      renderLine("WWWWWWWWWW"),
      renderLine("ＷＷＷＷＷＷＷＷ"),
      renderLine("🇺🇸🇯🇵🇫🇷🇧🇷🇿🇦🇮🇳"),
      renderLine("क्षक्षक्षक्ष"),
    ];

    expect(cards[0]!.intrinsicWidth).toBeGreaterThan(narrow.intrinsicWidth);
    for (const card of cards) {
      const textLength = Number(card.svg.match(/<tspan[^>]* textLength="(\d+)"/u)?.[1]);
      expect(textLength).toBeGreaterThan(0);
      expect(textLength).toBeLessThan(card.intrinsicWidth);
      expect(card.svg).toContain('lengthAdjust="spacingAndGlyphs"');
    }
  });

  test("wraps conservative wide grapheme classes within the social two-line bound", () => {
    for (const text of [
      "W".repeat(20),
      "Ｗ".repeat(20),
      "🇺🇸".repeat(14),
    ]) {
      const fixture = captionFixture({
        durationUs: 1_000_000,
        words: [{ endUs: 500_000, startUs: 0, text }],
      });
      const cue = compile(fixture)[0]!;
      expect(cue.lines).toHaveLength(2);
      expect(() => renderSocialCaptionSvg(cue, fixture.output)).not.toThrow();
    }
  });

  test("splits a token whose aggregate width fits two lines but has no valid two-line break", () => {
    const text = `${"W".repeat(13)}😀${"W".repeat(13)}`;
    const fixture = captionFixture({
      durationUs: 1_000_000,
      output: { pixelHeight: 1_920, pixelWidth: 1_080 },
      words: [{ endUs: 900_000, startUs: 0, text }],
    });
    const cues = compile(fixture);

    expect(cues.length).toBeGreaterThan(1);
    expect(cues.flatMap(cue => cue.lines).join("")).toBe(text);
    for (const cue of cues) {
      expect(() => renderSocialCaptionSvg(cue, fixture.output)).not.toThrow();
    }
  });

  test("bounds attached punctuation fragments per cue", () => {
    const words = Array.from({ length: 512 }, (_, index): TestWord => ({
      endUs: index * 100 + 80,
      startUs: index * 100,
      text: ",",
    }));
    const cues = compile(captionFixture({
      durationUs: words.length * 100,
      words,
    }));

    expect(cues.length).toBeGreaterThan(1);
    expect(Math.max(...cues.map(cue => cue.sourceWordIndices.length))).toBeLessThanOrEqual(20);
    expect(cues.flatMap(cue => cue.sourceWordIndices)).toHaveLength(words.length);
  });
});

describe("project caption rejection", () => {
  test("rejects no-speech, stale media, disabled audio, and an empty visible edit", () => {
    const noSpeech = captionFixture({ durationUs: 1_000_000, noSpeech: true });
    expect(() => compile(noSpeech)).toThrow(TypeError);
    expect(() => compile(noSpeech)).toThrow(/no speech/u);

    const current = captionFixture({
      durationUs: 1_000_000,
      words: [{ endUs: 400_000, startUs: 100_000, text: "current" }],
    });
    const changedProject = VideoProjectV1Schema.parse({
      ...current.project,
      assets: current.project.assets.map(asset => ({
        ...asset,
        streams: asset.streams.map(stream => ({
          ...stream,
          segments: stream.segments.map(segment => ({
            ...segment,
            sha256: "d".repeat(64),
          })),
        })),
      })),
    });
    const changedPlan = createDefaultProjectEditPlan(
      changedProject,
      EditPlanIdSchema.parse("plan_caption0002"),
      NOW,
    );
    expect(() => compileProjectCaptionCues({
      analysis: current.analysis,
      output: current.output,
      placementId: "placement_caption0001",
      plan: changedPlan,
      project: changedProject,
    })).toThrow(/stale/u);

    const inaudible = captionFixture({
      audioEnabled: false,
      durationUs: 1_000_000,
      words: [{ endUs: 400_000, startUs: 100_000, text: "muted" }],
    });
    expect(() => compile(inaudible)).toThrow(/audibly enabled/u);

    const cutAway = captionFixture({
      durationUs: 1_000_000,
      keep: [{ endUs: 200_000, startUs: 0 }],
      words: [{ endUs: 800_000, startUs: 500_000, text: "removed" }],
    });
    expect(() => compile(cutAway)).toThrow(/no visible transcript/u);
  });

  test("enforces explicit visible word and cue resource bounds", () => {
    const tooManyWords = Array.from(
      { length: PROJECT_CAPTION_LIMITS.maximumVisibleWords + 1 },
      (_, index): TestWord => ({
        endUs: index * 3 + 1,
        startUs: index * 3,
        text: "w",
      }),
    );
    expect(() => compile(captionFixture({
      durationUs: tooManyWords.length * 3,
      words: tooManyWords,
    }))).toThrow(/word caption bound/u);

    const tooManyCues = Array.from(
      { length: PROJECT_CAPTION_LIMITS.maximumVisibleCues + 1 },
      (_, index): TestWord => ({
        endUs: index * 3 + 1,
        startUs: index * 3,
        text: ".",
      }),
    );
    expect(() => compile(captionFixture({
      durationUs: tooManyCues.length * 3,
      words: tooManyCues,
    }))).toThrow(/cue caption bound/u);

    const maximallyLongWords = Array.from(
      { length: Math.ceil((PROJECT_CAPTION_LIMITS.maximumVisibleCues + 1) / 128) },
      (_, index): TestWord => ({
        endUs: index * 300 + 256,
        startUs: index * 300,
        text: "W".repeat(256),
      }),
    );
    expect(() => compile(captionFixture({
      durationUs: maximallyLongWords.length * 300,
      output: { pixelHeight: 1, pixelWidth: 1 },
      words: maximallyLongWords,
    }))).toThrow(/cue caption bound/u);
  });
});
