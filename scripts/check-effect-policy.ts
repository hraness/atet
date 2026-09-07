import { resolve } from "node:path";
import ts from "typescript";
import { createArchitectureProgram, inspectEffectArchitecture } from "./check-effect-architecture";

const root = resolve(import.meta.dirname, "..");
const modules = [
  "apps/desktop/application/operation.ts",
  "apps/desktop/application/operation-effects.ts",
  "apps/desktop/application/registry.ts",
  "apps/desktop/application/output-publication-lease.ts",
  "apps/desktop/application/operations/media/ingest.ts",
  "apps/desktop/application/operations/media/audio-effects.ts",
  "apps/desktop/application/operations/media/color-grade.ts",
  "apps/desktop/application/operations/media/transform-platform.ts",
  "apps/desktop/cli/media-effects-service.ts",
  "apps/desktop/cli/media-ingest.ts",
  "apps/desktop/cli/media-ingest-model.ts",
  "apps/desktop/cli/media-ingest-platform.ts",
  "apps/desktop/cli/media-ingest-program.ts",
  "apps/desktop/application/operations/render/project.ts",
  "apps/desktop/cli/atomic-render.ts",
  "apps/desktop/cli/atomic-render-effects.ts",
  "apps/desktop/cli/atomic-render-platform.ts",
  "apps/desktop/code/scheduler.ts",
  "apps/desktop/code/application-node-planner.ts",
  "apps/desktop/code/workflow-effects.ts",
  "apps/desktop/code/worker-client.ts",
  "apps/desktop/code/worker-effects.ts",
];
const desktop = createArchitectureProgram(resolve(root, "apps/desktop/tsconfig.json"));
const sdk = createArchitectureProgram(resolve(root, "tsconfig.json"));
const program = ts.createProgram({
  rootNames: [...new Set([...desktop.getRootFileNames(), ...sdk.getRootFileNames()])],
  options: desktop.getCompilerOptions(),
});
const findings = inspectEffectArchitecture(program, {
  root,
  modules,
  adapters: [
    "apps/desktop/application/operation-effects.ts",
    "apps/desktop/application/output-publication-lease.ts",
    "apps/desktop/application/operations/media/ingest.ts",
    "apps/desktop/application/operations/render/project.ts",
    "apps/desktop/cli/atomic-render-platform.ts",
    "apps/desktop/application/operations/media/transform-platform.ts",
    "apps/desktop/cli/media-effects-service.ts",
    "apps/desktop/cli/media-ingest-platform.ts",
    "apps/desktop/code/scheduler.ts",
    "apps/desktop/code/application-node-planner.ts",
    "apps/desktop/code/workflow-effects.ts",
    "apps/desktop/code/worker-client.ts",
    "apps/desktop/code/worker-effects.ts",
  ],
  runtimeRoots: [
    "apps/desktop/application/operation-effects.ts",
    "apps/desktop/code/workflow-effects.ts",
    "apps/desktop/code/worker-effects.ts",
  ],
  ignoredDirectories: ["scripts"],
});
for (const finding of findings) console.error(`${finding.file}:${finding.line} ${finding.rule}: ${finding.message}`);
if (findings.length > 0) process.exitCode = 1;
else console.log("Effect architecture policy passed.");
