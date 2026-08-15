#!/usr/bin/env bun

import {
  runMainEntrypoint,
  writeLegacyTransmuteInvocationWarning,
} from "./main.js";

writeLegacyTransmuteInvocationWarning(
  ["transmute"],
  message => process.stderr.write(message),
);
await runMainEntrypoint();
