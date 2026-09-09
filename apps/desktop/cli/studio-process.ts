import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

/** Trusted native code is not sandboxed. This port supervises its ordinary POSIX process group. */
export interface StudioProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly custody: "closed" | "unknown";
  readonly failure?: "cancelled" | "timeout" | "output-limit" | "spawn" | "descendants";
}

export interface StudioProcessOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maximumLogBytes: number;
  readonly signal?: AbortSignal;
  readonly inheritedFileDescriptors?: readonly number[];
  readonly onSpawn?: (pid: number) => Promise<void>;
  readonly assertBudget?: () => Promise<void>;
}

export interface StudioProcessPort {
  run(argv: readonly [string, ...string[]], options: StudioProcessOptions): Promise<StudioProcessResult>;
}

export function studioChildEnvironment(executable: string, workingRoot: string, threads: number): Record<string, string> {
  if (!Number.isInteger(threads) || threads < 1 || threads > 1024) throw new Error("Invalid native worker budget.");
  return {
    PATH: `${dirname(executable)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: join(workingRoot, "home"), TMPDIR: join(workingRoot, "tmp"),
    LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", TZ: "UTC",
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
    OMP_NUM_THREADS: String(threads), OPENBLAS_NUM_THREADS: String(threads),
    MKL_NUM_THREADS: String(threads), NUMEXPR_NUM_THREADS: String(threads),
    BLENDER_USER_RESOURCES: join(workingRoot, "blender-user"),
  };
}

function groupState(pid: number): "present" | "absent" | "unknown" {
  try { process.kill(-pid, 0); return "present"; }
  catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH" ? "absent" : "unknown";
  }
}

/** Detached sessions created by authored code are unsupported; process groups are custody, not confinement. */
export class NativeStudioProcess implements StudioProcessPort {
  async run(argv: readonly [string, ...string[]], options: StudioProcessOptions): Promise<StudioProcessResult> {
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Native studio execution currently requires POSIX process-group supervision.");
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 21_600_000
      || !Number.isSafeInteger(options.maximumLogBytes) || options.maximumLogBytes < 1 || options.maximumLogBytes > 4_194_304) throw new Error("Invalid native process limits.");
    if (options.signal?.aborted) return { exitCode: null, stdout: "", stderr: "", custody: "closed", failure: "cancelled" };
    const child = spawn(argv[0], [...argv.slice(1)], {
      cwd: options.cwd, env: { ...options.env }, detached: true,
      stdio: ["ignore", "pipe", "pipe", ...(options.inheritedFileDescriptors ?? [])],
    });
    let failure: StudioProcessResult["failure"];
    let total = 0;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let spawned = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let custodyDeadline: ReturnType<typeof setTimeout> | undefined;
    let budgetTimer: ReturnType<typeof setInterval> | undefined;
    let budgetCheck: Promise<void> | undefined;
    let spawnCheckpoint: Promise<void> | undefined;
    let leaderExited = false;
    let resolveExit: (code: number | null) => void = () => {};
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!spawned || child.pid === undefined) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) failure ??= "descendants"; }
    };
    const stop = (reason: NonNullable<StudioProcessResult["failure"]>) => {
      failure ??= reason;
      signalGroup("SIGTERM");
      escalation ??= setTimeout(() => signalGroup("SIGKILL"), 500);
      custodyDeadline ??= setTimeout(() => resolveExit(null), 5_500);
    };
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, options.maximumLogBytes - total);
      if (remaining > 0) target.push(Buffer.from(chunk.subarray(0, remaining)));
      total += chunk.length;
      if (total > options.maximumLogBytes) stop("output-limit");
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.stdout?.on("error", () => stop("spawn"));
    child.stderr?.on("error", () => stop("spawn"));
    const abort = () => stop("cancelled");
    const exit = new Promise<number | null>(resolve => {
      resolveExit = resolve;
      child.once("error", () => { failure ??= "spawn"; resolve(null); });
      child.once("exit", code => { leaderExited = true; resolve(code); });
    });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.once("spawn", () => {
      spawned = true;
      if (options.signal?.aborted) stop("cancelled");
      spawnCheckpoint = Promise.resolve().then(() => options.onSpawn?.(child.pid!)).catch(() => stop("spawn"));
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    if (options.assertBudget !== undefined) budgetTimer = setInterval(() => {
      if (budgetCheck !== undefined) return;
      budgetCheck = options.assertBudget!().catch(() => { stop("output-limit"); }).finally(() => { budgetCheck = undefined; });
    }, 500);
    try {
      const exitCode = await exit;
      if (budgetTimer !== undefined) { clearInterval(budgetTimer); budgetTimer = undefined; }
      let callbacksSettled = false, callbackTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        callbacksSettled = await Promise.race([
          Promise.all([spawnCheckpoint, budgetCheck]).then(() => true),
          new Promise<false>(resolve => { callbackTimer = setTimeout(() => resolve(false), 5_000); }),
        ]);
        if (!callbacksSettled) stop("descendants");
      } finally { if (callbackTimer !== undefined) clearTimeout(callbackTimer); }
      if (child.pid !== undefined && spawned && groupState(child.pid) !== "absent") {
        stop("descendants");
        const deadline = performance.now() + 5_000;
        while (groupState(child.pid) === "present" && performance.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      let custody: StudioProcessResult["custody"] = callbacksSettled && (!spawned || (child.pid !== undefined && leaderExited && groupState(child.pid) === "absent")) ? "closed" : "unknown";
      if (custody === "closed") {
        let drainTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const drained = await Promise.race([closed.then(() => true), new Promise<false>(resolve => { drainTimer = setTimeout(() => resolve(false), 5_000); })]);
          if (!drained) { custody = "unknown"; failure ??= "descendants"; }
        } finally { if (drainTimer !== undefined) clearTimeout(drainTimer); }
      }
      if (custody !== "closed") { child.stdout?.destroy(); child.stderr?.destroy(); }
      return { exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), custody, ...(failure === undefined ? {} : { failure }) };
    } finally {
      clearTimeout(timer);
      if (escalation !== undefined) clearTimeout(escalation);
      if (custodyDeadline !== undefined) clearTimeout(custodyDeadline);
      if (budgetTimer !== undefined) clearInterval(budgetTimer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
