import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createNodeBundleFileSystem } from "../core/storage";
import { withMutationLock } from "./mutation-lock";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { studioJson } from "./studio-files";
import type { StudioProcessPort, StudioProcessResult } from "./studio-process";

/** A machine-wide durable marker outlives the CLI. Unsettled native work blocks later dispatch. */
export async function withStudioProcessCustody<T>(input: {
  readonly machineStateRoot: string; readonly process: StudioProcessPort; readonly label: string;
  readonly signal: AbortSignal; readonly fence: () => Promise<void>;
}, execute: (process: StudioProcessPort) => Promise<T>): Promise<T> {
  const directory = await ensurePhysicalPrivateDirectoryWithin(input.machineStateRoot, "studio-native");
  return await withMutationLock(directory, { command: "studio native", label: input.label }, async lease => {
    const fs = createNodeBundleFileSystem(directory);
    const fence = async () => { await input.fence(); await lease.assertOwned(); };
    let current: unknown;
    try { current = JSON.parse(await fs.readText("activity.json")) as unknown; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (current !== undefined) {
      if (typeof current !== "object" || current === null || !("state" in current) || current.state !== "closed") throw new Error(`Unsettled native studio custody requires inspection: ${join(directory, "activity.json")}`);
    }
    let active = false;
    const process: StudioProcessPort = {
      run: async (argv, options) => {
        if (active) throw new Error("One studio custody lease can dispatch only one native process at a time.");
        active = true;
        const attempt = randomUUID(), startedAt = new Date().toISOString();
        let pid: number | undefined;
        const marker = (state: "starting" | "running" | "closed" | "unknown", result?: StudioProcessResult) => studioJson({
          kind: "slopcamera.studio-native-activity", schemaVersion: 1, attempt, label: input.label, startedAt, state,
          ...(pid === undefined ? {} : { processGroup: pid }),
          ...(result === undefined ? {} : { exitCode: result.exitCode, failure: result.failure ?? null, finishedAt: new Date().toISOString() }),
        });
        await fs.writeTextAtomicGuarded!("activity.json", marker("starting"), fence);
        let result: StudioProcessResult;
        try {
          result = await input.process.run(argv, {
            ...options,
            onSpawn: async processId => {
              pid = processId;
              await fs.writeTextAtomicGuarded!("activity.json", marker("running"), fence);
              await options.onSpawn?.(processId);
            },
          });
        } catch (error) {
          // An unexpected adapter exception cannot establish whether it dispatched native work.
          await fs.writeTextAtomicGuarded!("activity.json", marker("unknown"), () => lease.assertOwned());
          throw error;
        }
        // Terminal custody is evidence even when the caller's publication authority was cancelled.
        await fs.writeTextAtomicGuarded!("activity.json", marker(result.custody), () => lease.assertOwned());
        active = result.custody !== "closed";
        return result;
      },
    };
    return await execute(process);
  });
}
