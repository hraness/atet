import { describe, expect, test } from "bun:test";

import {
  compareLegacyIdentityInventory,
  duplicateIdentityAlternatives,
  legacyIdentitySnapshot,
  planLegacyIdentityInventoryUpdate,
  validateInventoryEntries,
} from "./legacy-identity";

describe("Atet predecessor identity inventory", () => {
  test("fingerprints exact predecessor-bearing lines and counts every occurrence", () => {
    expect(legacyIdentitySnapshot("fixture.ts", [
      "const canonical = 'atet.video-project';",
      "const prior = 'studio.video-project';",
      "const old = ['hraness.graphics', 'studio.edit-plan'];",
      "",
    ].join("\n"))).toEqual({
      identityLineCount: 2,
      identityLinesSha256: "3a837a9e204cd0b85fe63e42ae9260a7648557e744a48f9f20234d02bd23bd35",
      occurrenceCount: 3,
      path: "fixture.ts",
    });
    expect(legacyIdentitySnapshot("clean.ts", "const kind = 'atet.video-project';\n"))
      .toBeNull();
  });

  test("detects nonadjacent duplicates in schemas and TypeScript unions", () => {
    const source = `import { z } from "zod";
      const schema = z.union([
        z.literal("atet.video-project"),
        z.literal("studio.video-project"),
        z.literal("atet.video-project"),
      ]);
      const names = z.enum(["studio", "atet", "studio"]);
      type Kind = "studio.render-plan" | "atet.render-plan" | "studio.render-plan";
    `;
    expect(duplicateIdentityAlternatives("fixture.ts", source)).toEqual([
      "fixture.ts:2 repeats atet.video-project in z.union",
      "fixture.ts:7 repeats studio in z.enum",
      "fixture.ts:8 repeats studio.render-plan in a type union",
    ]);
  });

  test("tokenizes comments, escapes, regexes, and mixed union members without false adjacency", () => {
    const source = [
      `import { z as schema } from "zod";`,
      `      const prose = "z.union([z.literal('studio'), z.literal('studio')])";`,
      `      const pattern = /z\\.enum\\(\\["studio", "studio"\\]\\)/u;`,
      `      const template = \`type Hidden = "studio" | "studio"\`;`,
      "      const value = schema.union([",
      `        schema.literal("at\\u0065t.video-project"),`,
      "        unrelatedSchema,",
      `        schema.literal("atet.video-project"),`,
      "      ]);",
      "      const embedded = `value: ${schema.enum([\"studio\", \"atet\", \"studio\"])}`;",
      `      type Kind = "studio.render-plan" | Other | "studio.render-plan";`,
      `      const runtime = "studio" | "studio";`,
      "      const unrelated = other.union([other.literal(\"atet\"), other.literal(\"atet\")]);",
      "",
    ].join("\n");
    expect(duplicateIdentityAlternatives("fixture.ts", source)).toEqual([
      "fixture.ts:5 repeats atet.video-project in z.union",
      "fixture.ts:10 repeats studio in z.enum",
      "fixture.ts:11 repeats studio.render-plan in a type union",
    ]);
    expect(duplicateIdentityAlternatives("fixture.md", source)).toEqual([]);
  });

  test("discovers default and namespace Zod bindings", () => {
    const source = `import schema, * as zod from "zod";
      const first = schema.union([
        schema.literal("atet.run"),
        schema.literal("atet.run"),
      ]);
      const second = zod.enum(["studio.run", "studio.run"]);`;
    expect(duplicateIdentityAlternatives("fixture.ts", source)).toEqual([
      "fixture.ts:2 repeats atet.run in z.union",
      "fixture.ts:6 repeats studio.run in z.enum",
    ]);
  });

  test("compares the exact inventory and rejects missing, surplus, or changed rows", () => {
    const entry = {
      categories: ["serialized-reader"] as const,
      identityLineCount: 1,
      identityLinesSha256: "0".repeat(64),
      occurrenceCount: 1,
      path: "src/example.ts",
    };
    expect(compareLegacyIdentityInventory([entry], [{
      identityLineCount: 2,
      identityLinesSha256: "1".repeat(64),
      occurrenceCount: 3,
      path: "src/example.ts",
    }, {
      identityLineCount: 1,
      identityLinesSha256: "2".repeat(64),
      occurrenceCount: 1,
      path: "dist/example.js",
    }], new Set(["dist/example.js"]))).toEqual([
      "legacy identity inventory is missing dist/example.js",
      "src/example.ts identity line count changed: expected 1, received 2",
      "src/example.ts identity occurrence count changed: expected 1, received 3",
      "src/example.ts identity-bearing lines changed",
    ]);
    expect(compareLegacyIdentityInventory([entry], [], new Set())).toEqual([
      "legacy identity inventory has surplus src/example.ts",
    ]);
  });

  test("updates generated rows but refuses to bless a changed source row", () => {
    const sourceEntry = {
      categories: ["serialized-reader"] as const,
      identityLineCount: 1,
      identityLinesSha256: "0".repeat(64),
      occurrenceCount: 1,
      path: "src/example.ts",
    };
    const generatedEntry = {
      categories: ["generated"] as const,
      identityLineCount: 1,
      identityLinesSha256: "1".repeat(64),
      occurrenceCount: 1,
      path: "dist/old.js",
    };
    expect(planLegacyIdentityInventoryUpdate(
      [generatedEntry, sourceEntry],
      [{
        identityLineCount: 2,
        identityLinesSha256: "2".repeat(64),
        occurrenceCount: 2,
        path: "dist/new.js",
      }, {
        identityLineCount: 2,
        identityLinesSha256: "3".repeat(64),
        occurrenceCount: 2,
        path: "src/example.ts",
      }],
      new Set(["dist/new.js"]),
    )).toEqual({
      entries: [{
        categories: ["generated"],
        identityLineCount: 2,
        identityLinesSha256: "2".repeat(64),
        occurrenceCount: 2,
        path: "dist/new.js",
      }, sourceEntry],
      problems: [
        "src/example.ts changed; review and edit its source inventory row explicitly",
      ],
    });
  });

  test("tracks committed generated identity without blessing ignored build output", () => {
    const sourceSnapshot = {
      identityLineCount: 1,
      identityLinesSha256: "0".repeat(64),
      occurrenceCount: 1,
      path: "src/example.ts",
    };
    const generatedSnapshot = {
      identityLineCount: 1,
      identityLinesSha256: "1".repeat(64),
      occurrenceCount: 1,
      path: "dist/committed.js",
    };
    const ignoredGeneratedSnapshot = {
      identityLineCount: 1,
      identityLinesSha256: "2".repeat(64),
      occurrenceCount: 1,
      path: "apps/web/dist/ignored.js",
    };
    const sourceEntry = {
      ...sourceSnapshot,
      categories: ["serialized-reader"] as const,
    };
    const generatedEntry = {
      ...generatedSnapshot,
      categories: ["generated"] as const,
    };
    const ignoredGeneratedEntry = {
      ...ignoredGeneratedSnapshot,
      categories: ["generated"] as const,
    };
    const actual = [sourceSnapshot, generatedSnapshot, ignoredGeneratedSnapshot];
    const trackedGeneratedPaths = new Set([generatedEntry.path]);

    expect(compareLegacyIdentityInventory(
      [generatedEntry, sourceEntry],
      actual,
      trackedGeneratedPaths,
    )).toEqual([]);
    expect(planLegacyIdentityInventoryUpdate(
      [ignoredGeneratedEntry, generatedEntry, sourceEntry],
      actual,
      trackedGeneratedPaths,
    )).toEqual({
      entries: [generatedEntry, sourceEntry],
      problems: [],
    });
    expect(compareLegacyIdentityInventory(
      [ignoredGeneratedEntry, generatedEntry, sourceEntry],
      actual,
      trackedGeneratedPaths,
    )).toEqual([
      "legacy identity inventory has surplus apps/web/dist/ignored.js",
    ]);
    expect(compareLegacyIdentityInventory(
      [],
      [actual[0]!],
      new Set(),
    )).toEqual([
      "legacy identity inventory is missing src/example.ts",
    ]);
  });

  test("rejects malformed, duplicate, and uncategorized inventory entries", () => {
    expect(validateInventoryEntries([{
      categories: [],
      identityLineCount: 0,
      identityLinesSha256: "bad",
      occurrenceCount: 0,
      path: "fixture.ts",
    }, {
      categories: ["test-fixture"],
      identityLineCount: 1,
      identityLinesSha256: "0".repeat(64),
      occurrenceCount: 1,
      path: "fixture.ts",
    }])).toEqual([
      "fixture.ts has no compatibility category",
      "fixture.ts has an invalid identity line count",
      "fixture.ts has an invalid identity occurrence count",
      "fixture.ts has an invalid identity line hash",
      "duplicate inventory path fixture.ts",
      "fixture.ts is not in strictly sorted path order",
    ]);
  });

  test("reserves the generated category for generated output paths", () => {
    const snapshot = {
      identityLineCount: 1,
      identityLinesSha256: "0".repeat(64),
      occurrenceCount: 1,
    };
    expect(validateInventoryEntries([{
      ...snapshot,
      categories: ["serialized-reader"],
      path: "dist/example.js",
    }, {
      ...snapshot,
      categories: ["generated"],
      path: "src/example.ts",
    }])).toEqual([
      "dist/example.js must use only the generated compatibility category",
      "src/example.ts cannot use the generated compatibility category",
    ]);
  });
});
