import { describe, expect, test } from "bun:test";

import {
  canonicalizeUnifiedCliArgs,
  runPortableSurface,
} from "./portable-surface";

describe("unified portable Transmute CLI surface", () => {
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
    expect(writes[0]?.html).toContain("TransmuteOverlay.onFrame");
    expect(logs).toEqual(["Created /workspace/overlays/title.html"]);
  });
});
