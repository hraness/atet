import { CliError } from "./errors";

export interface CliIo {
  readonly cwd: () => string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  readonly platform: NodeJS.Platform;
  /** Reads sensitive piped input without converting it to argv or environment state. */
  readonly readStdin?: (maximumBytes: number) => Promise<Uint8Array>;
  readonly stderr: (value: string) => void;
  readonly stdout: (value: string) => void;
}

export interface RunOptions {
  readonly abortSignal?: AbortSignal;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * POSIX file descriptors duplicated into the child starting at descriptor 3.
   * The caller retains ownership and must keep them open until `run` settles.
   */
  readonly inheritedFileDescriptors?: readonly number[];
  readonly maxOutputBytes?: number;
  readonly stdin?: "ignore";
  readonly timeoutMs?: number;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ProcessRunner {
  run(argv: readonly [string, ...string[]], options?: RunOptions): Promise<RunResult>;
}

const DEFAULT_OUTPUT_LIMIT = 1_000_000;
const FORBIDDEN_CHILD_ENVIRONMENT_NAMES = new Set([
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
]);

/** Credentials remain in the trusted process and never reach media/tool children. */
export function environmentWithoutGatewayCredentials(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (FORBIDDEN_CHILD_ENVIRONMENT_NAMES.has(name.toLocaleUpperCase("en-US"))) {
      delete environment[name];
    }
  }
  return environment;
}

class BoundedByteTail {
  readonly #bytes: Uint8Array;
  readonly #limit: number;
  #length = 0;
  #truncated = false;
  #writeOffset = 0;

  constructor(limit: number) {
    this.#bytes = new Uint8Array(limit);
    this.#limit = limit;
  }

  append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    if (chunk.byteLength >= this.#limit) {
      this.#truncated ||= this.#length > 0 || chunk.byteLength > this.#limit;
      this.#bytes.set(chunk.subarray(chunk.byteLength - this.#limit));
      this.#length = this.#limit;
      this.#writeOffset = 0;
      return;
    }

    const firstLength = Math.min(chunk.byteLength, this.#limit - this.#writeOffset);
    this.#bytes.set(chunk.subarray(0, firstLength), this.#writeOffset);
    if (firstLength < chunk.byteLength) this.#bytes.set(chunk.subarray(firstLength));
    this.#writeOffset = (this.#writeOffset + chunk.byteLength) % this.#limit;
    this.#truncated ||= this.#length + chunk.byteLength > this.#limit;
    this.#length = Math.min(this.#limit, this.#length + chunk.byteLength);
  }

  text(): string {
    const bytes = new Uint8Array(this.#length);
    if (this.#length < this.#limit) {
      bytes.set(this.#bytes.subarray(0, this.#length));
    } else {
      const firstLength = this.#limit - this.#writeOffset;
      bytes.set(this.#bytes.subarray(this.#writeOffset), 0);
      if (this.#writeOffset > 0) bytes.set(this.#bytes.subarray(0, this.#writeOffset), firstLength);
    }

    let start = 0;
    if (this.#truncated) {
      while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
    }
    return new TextDecoder().decode(bytes.subarray(start));
  }
}

async function readBoundedTail(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const tail = new BoundedByteTail(limit);
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      tail.append(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return tail.text();
}

export class BunProcessRunner implements ProcessRunner {
  async run(argv: readonly [string, ...string[]], options: RunOptions = {}): Promise<RunResult> {
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new CliError("internal", "Process output limit must be a positive safe integer.");
    }
    const timeoutMs = options.timeoutMs;
    if (
      timeoutMs !== undefined
      && (
        !Number.isSafeInteger(timeoutMs)
        || timeoutMs < 1
        || timeoutMs > 24 * 60 * 60_000
      )
    ) {
      throw new CliError(
        "internal",
        "Process timeout must be a whole number of milliseconds from 1 through 86400000.",
      );
    }
    const inheritedFileDescriptors = options.inheritedFileDescriptors ?? [];
    if (
      inheritedFileDescriptors.length > 16
      || inheritedFileDescriptors.some(descriptor => (
        !Number.isSafeInteger(descriptor)
        || descriptor < 0
      ))
    ) {
      throw new CliError(
        "internal",
        "Inherited file descriptors must contain at most 16 nonnegative integers.",
      );
    }
    if (options.abortSignal?.aborted === true) {
      throw new CliError("cancelled", "Process execution was cancelled before launch.");
    }

    try {
      const environment = environmentWithoutGatewayCredentials(options.env ?? process.env);
      // FFmpeg honors FFREPORT before processing argv and can otherwise
      // overwrite an immutable input selected by the user.
      for (const name of Object.keys(environment)) {
        if (name.toLocaleUpperCase("en-US") === "FFREPORT") {
          delete environment[name];
        }
      }
      const child = Bun.spawn([...argv], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: environment,
        stdio: [
          "ignore",
          "pipe",
          "pipe",
          ...inheritedFileDescriptors,
        ],
      });
      const stdout = readBoundedTail(child.stdout, maxOutputBytes);
      const stderr = readBoundedTail(child.stderr, maxOutputBytes);
      const exited = child.exited;
      let timedOut = false;
      let cancelled = false;
      const abortSignal = options.abortSignal;
      const abortHandler = () => {
        cancelled = true;
        try {
          child.kill(9);
        } catch {
          // The child may have exited immediately before cancellation.
        }
      };
      abortSignal?.addEventListener("abort", abortHandler, { once: true });
      if (abortSignal?.aborted === true) abortHandler();
      const timer = timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            try {
              child.kill(9);
            } catch {
              // The child may have exited immediately before the deadline.
            }
          }, timeoutMs);
      try {
        const [boundedStdout, boundedStderr, exitCode] = await Promise.all([stdout, stderr, exited]);
        if (cancelled) {
          throw new CliError("cancelled", "Process execution was cancelled.");
        }
        if (timedOut) {
          throw new CliError(
            "subprocess",
            `Process exceeded its ${timeoutMs}-millisecond deadline.`,
          );
        }
        return {
          exitCode,
          stderr: boundedStderr,
          stdout: boundedStdout,
        };
      } catch (error) {
        try {
          child.kill(9);
        } catch {
          // The child may already have exited between the stream failure and cleanup.
        }
        await Promise.allSettled([stdout, stderr, exited]);
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        abortSignal?.removeEventListener("abort", abortHandler);
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      return {
        exitCode: 127,
        stderr: error instanceof Error ? error.message : String(error),
        stdout: "",
      };
    }
  }
}

export const processIo: CliIo = {
  cwd: () => process.cwd(),
  env: process.env,
  now: () => new Date(),
  platform: process.platform,
  readStdin: async (maximumBytes) => {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new CliError("internal", "Standard-input byte limit must be a positive safe integer.");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = Bun.stdin.stream().getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maximumBytes) {
          throw new CliError("invalid-data", `Standard input exceeds its ${maximumBytes}-byte limit.`);
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  },
  stderr: (value) => {
    process.stderr.write(value);
  },
  stdout: (value) => {
    process.stdout.write(value);
  },
};

export function writeJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value)}\n`);
}

export function writeLine(io: CliIo, value = ""): void {
  io.stdout(`${value}\n`);
}
