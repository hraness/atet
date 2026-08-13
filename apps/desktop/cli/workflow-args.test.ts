import { describe, expect, test } from "bun:test";

import { parseCliArgs } from "./args";
import { commandHelp, completions } from "./help";

describe("workflow command arguments", () => {
  test("parses discovery, planning, execution, and durable control commands", () => {
    expect(parseCliArgs(["operations", "show", "analysis.faces", "--json"]))
      .toEqual({
        json: true,
        kind: "operations-show",
        operation: "analysis.faces",
      });
    expect(parseCliArgs([
      "workflows", "run", "polished-screen-demo",
      "--input", "inputs/demo.json", "--jobs", "8", "--jsonl",
    ])).toEqual({
      input: "inputs/demo.json",
      jobs: 8,
      json: true,
      jsonl: true,
      kind: "workflows-run",
      providerOptions: undefined,
      workflow: "polished-screen-demo",
    });
    expect(parseCliArgs([
      "code", "run", "workflows/demo.ts",
      "--input", "inputs/demo.json",
      "--plan", "a".repeat(64),
      "--provider-options", "ignored/gateway-options.json",
    ])).toMatchObject({
      jobs: 4,
      kind: "code-run",
      plan: "a".repeat(64),
      providerOptions: "ignored/gateway-options.json",
    });
    expect(parseCliArgs([
      "runs", "approve", "run_example01", "analyze/faces",
      "--node-plan", "b".repeat(64),
    ])).toMatchObject({
      kind: "runs-approve",
      nodeKey: "analyze/faces",
      planKind: "effect",
    });
    expect(parseCliArgs([
      "runs", "resume", "run_example01",
      "--provider-options", "ignored/gateway-options.json",
      "--replay-ambiguous-code", "derive/outline",
      "--replay-ambiguous-code", "derive/chapters",
    ])).toMatchObject({
      kind: "runs-resume",
      providerOptions: "ignored/gateway-options.json",
      replayAmbiguousCode: ["derive/outline", "derive/chapters"],
    });
  });

  test("rejects conflicting output modes, unsafe bounds, and ambiguous approvals", () => {
    expect(() => parseCliArgs([
      "code", "run", "workflow.ts", "--input", "input.json",
      "--json", "--jsonl",
    ])).toThrow(/only one/u);
    expect(() => parseCliArgs([
      "workflows", "run", "demo", "--input", "input.json", "--jobs", "65",
    ])).toThrow(/1 through 64/u);
    expect(() => parseCliArgs([
      "runs", "approve", "run_example01", "node",
      "--node-plan", "a".repeat(64),
      "--preparation-plan", "b".repeat(64),
    ])).toThrow(/exactly one/u);
  });

  test("advertises trusted-code limits and progressively disclosed commands", () => {
    expect(commandHelp(["code"])).toContain("Trusted code mode is not a sandbox");
    expect(commandHelp(["runs"])).toContain("only a later resume executes work");
    expect(commandHelp(["runs"])).toContain("normal resume never evaluates persisted trusted code");
    expect(completions(["code", ""])).toEqual(["init", "check", "plan", "run"]);
  });
});
