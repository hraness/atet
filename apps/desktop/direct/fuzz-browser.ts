#!/usr/bin/env bun
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDirectBombadilFuzz } from "@hraness/direct/tooling/bombadil";

const directRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(directRoot, "../../..");

await runDirectBombadilFuzz({
  artifactName: "atet",
  baseUrl: "http://127.0.0.1:5174",
  entryPath: "/",
  expectedRoute: "/",
  label: "Atet Direct Bombadil fuzzing",
  repositoryRoot,
  scenario: "idle-ready",
  specificationPath: resolve(directRoot, "bombadil-campaign.ts"),
  targetQuery: { directFrame: "1" },
  server: {
    command: [
      process.execPath,
      "run",
      "dev:direct",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      "{port}",
      "--strictPort",
    ],
    cwd: repositoryRoot,
    env: { CI: "1" },
    readinessPath: "/",
    startupTimeoutMs: 30_000,
  },
}, process.argv.slice(2));
