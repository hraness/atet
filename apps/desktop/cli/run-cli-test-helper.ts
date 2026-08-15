import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createProcessLocalHostResourceCoordinator,
  defaultAtetHostResourceProfile,
  type HostResourceCoordinator,
  type HostResourceProfile,
} from "@hraness/atet/host-resources";

import { runCli as runProductionCli } from "./commands";

const TEST_HOST_PARALLELISM = 8;
const testFileNamePattern = /^[a-z0-9][a-z0-9.-]*\.test\.ts$/u;

function testHostResourceProfile(
  testFileUrl: string,
  invocation?: number,
): HostResourceProfile {
  const testFileName = basename(fileURLToPath(testFileUrl));
  if (!testFileNamePattern.test(testFileName)) {
    throw new Error(`CLI test runner requires a *.test.ts file URL, received ${testFileName}.`);
  }
  if (
    invocation !== undefined
    && (!Number.isSafeInteger(invocation) || invocation < 1 || invocation > 32)
  ) {
    throw new Error("CLI test runner invocation must be an integer from 1 through 32.");
  }
  const defaults = defaultAtetHostResourceProfile(TEST_HOST_PARALLELISM);
  return {
    capacities: defaults.capacities,
    id: invocation === undefined
      ? `atet.cli-test/${testFileName}/v1`
      : `atet.cli-test/${testFileName}/invocation-${invocation}/v1`,
  };
}

export function createCliTestHostResourceCoordinator(
  testFileUrl: string,
  invocation?: number,
): HostResourceCoordinator {
  return createProcessLocalHostResourceCoordinator({
    profile: testHostResourceProfile(testFileUrl, invocation),
  });
}

export function createCliTestRunner(
  testFileUrl: string,
  invocation?: number,
): typeof runProductionCli {
  const hostResourceCoordinator = createCliTestHostResourceCoordinator(
    testFileUrl,
    invocation,
  );
  return async (argv, dependencies = {}) => await runProductionCli(argv, {
    ...dependencies,
    hostResourceCoordinator,
  });
}
