import { describe, expect, test } from "bun:test";

import { canonicalJson } from "../core/canonical-json";
import { commandHelp } from "./help";
import {
  canonicalizeUnifiedCliArgs,
  runPortableSurface,
} from "./portable-surface";

describe("unified portable Atet CLI surface", () => {
  test("delegates the complete headless diagram and explicit-file image grammar", async () => {
    const delegated: readonly string[][] = [];
    const runHeadless = (argv: readonly string[]): Promise<void> => {
      (delegated as string[][]).push([...argv]);
      return Promise.resolve();
    };
    for (const argv of [
      ["diagram", "init", "flow.diagram.json"],
      ["diagram", "check", "flow.diagram.json", "--strict"],
      ["diagram", "render", "flow.diagram.json", "--scale", "2"],
      ["image", "vectorize", "sketch.png", "--output", "sketch.svg"],
      ["image", "generate", "title", "--output", "title.webp"],
    ] as const) {
      expect(await runPortableSurface(argv, { runHeadless })).toBe(0);
    }
    expect(delegated).toEqual([
      ["diagram", "init", "flow.diagram.json"],
      ["diagram", "check", "flow.diagram.json", "--strict"],
      ["diagram", "render", "flow.diagram.json", "--scale", "2"],
      ["image", "vectorize", "sketch.png", "--output", "sketch.svg"],
      ["image", "generate", "title", "--output", "title.webp"],
    ]);
  });

  test("delegates portable MCP, canvas, skill, and semantic code without shadowing local code mode", async () => {
    const delegated: string[][] = [];
    const runHeadless = (argv: readonly string[]): Promise<void> => {
      delegated.push([...argv]);
      return Promise.resolve();
    };
    for (const argv of [
      ["mcp", "--root", "/workspace"],
      ["canvas", "status"],
      ["canvas", "url"],
      ["canvas", "install", "--yes"],
      ["skill", "path"],
      ["skill", "install", "--target", "codex"],
      ["code", "search", "diagram"],
      ["code", "execute", "diagram.render", "--input", "{}"],
    ] as const) {
      expect(await runPortableSurface(argv, { runHeadless })).toBe(0);
    }
    expect(delegated).toEqual([
      ["mcp", "--root", "/workspace"],
      ["canvas", "status"],
      ["canvas", "url"],
      ["canvas", "install", "--yes"],
      ["skill", "path"],
      ["skill", "install", "--target", "codex"],
      ["code", "search", "diagram"],
      ["code", "execute", "diagram.render", "--input", "{}"],
    ]);
    for (const argv of [
      ["code", "init", "workflow.ts"],
      ["code", "check", "workflow.ts"],
      ["code", "plan", "workflow.ts"],
      ["code", "run", "workflow.ts"],
    ] as const) {
      expect(await runPortableSurface(argv, { runHeadless })).toBeUndefined();
    }
  });

  test("routes project image generation to the existing desktop Gateway command", () => {
    expect(canonicalizeUnifiedCliArgs([
      "image",
      "generate",
      "--model",
      "openai/gpt-image-1.5",
      "--prompt",
      "clean title card",
    ])).toEqual([
      "ai",
      "image",
      "generate",
      "--model",
      "openai/gpt-image-1.5",
      "--prompt",
      "clean title card",
    ]);
    expect(canonicalizeUnifiedCliArgs([
      "image",
      "generate",
      "--prompt",
      "clean title card",
      "--output",
      "title.webp",
    ])).toEqual([
      "image",
      "generate",
      "clean title card",
      "--output",
      "title.webp",
    ]);
  });

  test("writes a complete non-overwriting HTML scaffold through the existing API", async () => {
    const writes: Array<{ readonly html: string; readonly path: string }> = [];
    const logs: string[] = [];
    expect(await runPortableSurface([
      "html",
      "scaffold",
      "paper-shaders",
      "--output",
      "overlays/title.html",
    ], {
      cwd: () => "/workspace",
      log: value => logs.push(value),
      writeScaffold: (path, html) => {
        writes.push({ html, path });
        return Promise.resolve();
      },
    })).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/workspace/overlays/title.html");
    expect(writes[0]?.html).toContain('from "@paper-design/shaders"');
    expect(writes[0]?.html).toContain("AtetOverlay.onFrame");
    expect(logs).toEqual(["Created /workspace/overlays/title.html"]);
  });

  test.each([
    ["p5", 'from "p5"'],
    ["two", 'from "two.js"'],
  ] as const)("accepts the catalog-backed %s scaffold kind", async (kind, expectedImport) => {
    const writes: Array<{ readonly html: string; readonly path: string }> = [];
    expect(await runPortableSurface([
      "html",
      "scaffold",
      kind,
      "--output",
      `${kind}.html`,
    ], {
      cwd: () => "/workspace",
      log: () => undefined,
      writeScaffold: (path, html) => {
        writes.push({ html, path });
        return Promise.resolve();
      },
    })).toBe(0);
    expect(writes).toEqual([{
      html: expect.stringContaining(expectedImport),
      path: `/workspace/${kind}.html`,
    }]);
  });

  test("lists the closed HTML scaffold catalog in stable human and canonical JSON forms", async () => {
    const humanLogs: string[] = [];
    expect(await runPortableSurface(["html", "catalog"], {
      log: value => humanLogs.push(value),
    })).toBe(0);
    expect(humanLogs).toHaveLength(1);
    expect(humanLogs[0]?.split("\n")).toHaveLength(15);
    expect(humanLogs[0]).toContain(
      "plain  job=dom-layout  substrate=dom  libraries=none",
    );
    expect(humanLogs[0]).toContain(
      "p5  job=immediate-2d  substrate=canvas-2d  libraries=p5@2.3.2",
    );
    expect(humanLogs[0]).toContain(
      "two  job=retained-2d  substrate=webgl  libraries=two.js@0.8.24",
    );
    expect(humanLogs[0]).toContain("Best for:");

    const jsonLogs: string[] = [];
    expect(await runPortableSurface(["html", "catalog", "--json"], {
      log: value => jsonLogs.push(value),
    })).toBe(0);
    expect(jsonLogs).toHaveLength(1);
    const parsed = JSON.parse(jsonLogs[0]!) as {
      readonly profiles: readonly Readonly<{
        readonly bestFor: string;
        readonly clockIntegration: string;
        readonly kind: string;
        readonly libraries: readonly Readonly<{
          readonly specifier: string;
          readonly version: string;
        }>[];
        readonly primaryJob: string;
        readonly substrate: string;
        readonly summary: string;
      }>[];
      readonly schemaVersion: number;
    };
    expect(jsonLogs[0]).toBe(canonicalJson(parsed));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.profiles.map(profile => profile.kind)).toEqual([
      "plain",
      "motion",
      "p5",
      "two",
      "paper-shaders",
      "three",
      "vgpu",
    ]);
    expect(parsed.profiles.map(profile => profile.libraries)).toEqual([
      [],
      [{ specifier: "motion", version: "12.42.2" }],
      [{ specifier: "p5", version: "2.3.2" }],
      [{ specifier: "two.js", version: "0.8.24" }],
      [{ specifier: "@paper-design/shaders", version: "0.0.77" }],
      [{ specifier: "three", version: "0.185.1" }],
      [{ specifier: "vgpu", version: "0.3.1" }],
    ]);
    expect(Object.keys(parsed.profiles[0]!).sort()).toEqual([
      "bestFor",
      "clockIntegration",
      "kind",
      "libraries",
      "primaryJob",
      "substrate",
      "summary",
    ]);
  });

  test.each(([
    ["html", "catalog", "extra"],
    ["html", "catalog", "--json", "--json"],
    ["html", "catalog", "--json", "extra"],
    ["html", "catalog", "--json=true"],
    ["html", "catalog", "--output", "catalog.json"],
  ] as const).map(argv => [argv] as const))(
    "rejects HTML catalog grammar outside the optional exact JSON flag: %j",
    async (argv) => {
      await expect(runPortableSurface(argv)).rejects.toThrow(
        "Use atet html catalog [--json].",
      );
    },
  );

  test("documents catalog discovery and every supported scaffold kind", () => {
    expect(commandHelp([])).toContain("html catalog|scaffold");
    expect(commandHelp(["html"])).toContain("atet html catalog [--json]");
    expect(commandHelp(["html"])).toContain(
      "<plain|motion|p5|two|paper-shaders|three|vgpu>",
    );
    expect(commandHelp(["html"])).toContain("current exact browser-library versions");
  });
});
