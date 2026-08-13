import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { CliError } from "./errors";
import { probeVisualMediaSummary } from "./analyzer";
import { BunProcessRunner, type ProcessRunner, type RunOptions, type RunResult } from "./io";
import {
  ingestProjectMedia,
  parseMediaProbe,
  SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
  type MediaIngestDurability,
} from "./media-ingest";

const NOW = new Date("2026-07-22T16:00:00.000Z");
const FFMPEG = Bun.which("ffmpeg");
const FFPROBE = Bun.which("ffprobe");

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

function probeOutput(): string {
  return JSON.stringify({
    format: { duration: "2.500000", format_name: "mov,mp4,m4a,3gp,3g2,mj2", start_time: "10.000000" },
    programs: [],
    stream_groups: [],
    streams: [{
      avg_frame_rate: "30000/1001",
      codec_name: "h264",
      codec_type: "video",
      duration: "2.000000",
      height: 1_080,
      index: 0,
      r_frame_rate: "30000/1001",
      start_time: "10.100000",
      width: 1_920,
    }, {
      channels: 2,
      codec_name: "aac",
      codec_type: "audio",
      duration: "1.500000",
      index: 2,
      sample_rate: "48000",
      start_time: "10.250000",
    }],
  });
}

class ProbeRunner implements ProcessRunner {
  readonly calls: { readonly argv: readonly string[]; readonly options: RunOptions | undefined }[] = [];

  run(argv: readonly [string, ...string[]], options?: RunOptions): Promise<RunResult> {
    this.calls.push({ argv, options });
    return Promise.resolve({ exitCode: 0, stderr: "", stdout: probeOutput() });
  }
}

class FailingProbeRunner implements ProcessRunner {
  readonly calls: string[][] = [];

  run(argv: readonly [string, ...string[]]): Promise<RunResult> {
    this.calls.push([...argv]);
    return Promise.resolve({ exitCode: 1, stderr: "invalid media", stdout: "" });
  }
}

describe("project media probe parsing", () => {
  test("uses format duration and preserves independently indexed video and audio facts", () => {
    expect(parseMediaProbe(probeOutput())).toEqual({
      container: "mov",
      durationUs: 2_500_000,
      streams: [{
        assetRange: { endUs: 2_100_000, startUs: 100_000 },
        avg_frame_rate: "30000/1001",
        codec_name: "h264",
        codec_type: "video",
        duration: "2.000000",
        fileRange: { endUs: 2_100_000, startUs: 100_000 },
        height: 1_080,
        index: 0,
        r_frame_rate: "30000/1001",
        start_time: "10.100000",
        width: 1_920,
      }, {
        assetRange: { endUs: 1_750_000, startUs: 250_000 },
        channels: 2,
        codec_name: "aac",
        codec_type: "audio",
        duration: "1.500000",
        fileRange: { endUs: 1_750_000, startUs: 250_000 },
        index: 2,
        sample_rate: "48000",
        start_time: "10.250000",
      }],
    });
  });

  test("rejects malformed, durationless, and structurally incomplete probe output", () => {
    expect(() => parseMediaProbe("not-json")).toThrow(/not valid JSON/u);
    expect(() => parseMediaProbe(JSON.stringify({
      format: { format_name: "mov" },
      streams: [{ codec_name: "h264", codec_type: "video", height: 1_080, index: 0, width: 1_920 }],
    }))).toThrow(/positive finite duration/u);
    expect(() => parseMediaProbe(JSON.stringify({
      format: { duration: "1", format_name: "mov" },
      streams: [{ codec_name: "h264", codec_type: "video", index: 0 }],
    }))).toThrow(/pixel dimensions/u);
  });

  test("excludes attached cover art from playable video streams", () => {
    expect(parseMediaProbe(JSON.stringify({
      format: { duration: "3", format_name: "mp3", start_time: "0" },
      streams: [{
        channels: 2,
        codec_name: "mp3",
        codec_type: "audio",
        duration: "3",
        index: 0,
        sample_rate: "48000",
        start_time: "0",
      }, {
        codec_name: "mjpeg",
        codec_type: "video",
        disposition: { attached_pic: 1 },
        duration: "3",
        index: 1,
        start_time: "-100",
      }],
    }))).toMatchObject({
      container: "mp3",
      durationUs: 3_000_000,
      streams: [{ codec_type: "audio", index: 0 }],
    });
  });

  test("uses WebM duration tags before the normalized container fallback", () => {
    expect(parseMediaProbe(JSON.stringify({
      format: { duration: "2.000000", format_name: "matroska,webm", start_time: "-0.007000" },
      streams: [{
        avg_frame_rate: "10/1",
        codec_name: "vp9",
        codec_type: "video",
        height: 24,
        index: 0,
        r_frame_rate: "10/1",
        start_time: "0.000000",
        tags: { DURATION: "00:00:02.000000000" },
        width: 32,
      }, {
        channels: 1,
        codec_name: "opus",
        codec_type: "audio",
        index: 1,
        sample_rate: "48000",
        start_time: "-0.007000",
        tags: { DURATION: "00:00:00.758000000" },
      }],
    }))).toMatchObject({
      container: "matroska",
      durationUs: 2_007_000,
      streams: [{
        assetRange: { endUs: 2_007_000, startUs: 7_000 },
        index: 0,
      }, {
        assetRange: { endUs: 758_000, startUs: 0 },
        index: 1,
      }],
    });
  });
});

test("imports external media once by content hash and models every probed stream", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "transmute-media-ingest-"));
  try {
    const requestedRepositoryRoot = join(temporary, "repository");
    const projectDirectory = join(requestedRepositoryRoot, "artifacts", "transmute", "projects", "project_ingest01");
    const source = join(temporary, "external", "Camera Take.MOV");
    const sourceAlias = join(temporary, "external", "same bytes.bin");
    await Promise.all([
      mkdir(projectDirectory, { recursive: true }),
      mkdir(join(temporary, "external"), { recursive: true }),
    ]);
    const repositoryRoot = await realpath(requestedRepositoryRoot);
    const contents = Buffer.from("independent camera media\n", "utf8");
    await writeFile(source, contents);
    await writeFile(sourceAlias, contents);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const runner = new ProbeRunner();
    const options = {
      ffprobe: "/opt/homebrew/bin/ffprobe",
      now: NOW,
      projectDirectory,
      repositoryRoot,
      role: "camera" as const,
      runner,
      sourcePath: source,
    };

    const first = await ingestProjectMedia(options);
    const second = await ingestProjectMedia(options);
    const aliased = await ingestProjectMedia({ ...options, sourcePath: sourceAlias });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(aliased.created).toBe(false);
    expect(aliased.absolutePath).toBe(first.absolutePath);
    expect({ ...first, created: false }).toEqual(second);
    expect(basename(first.absolutePath)).toBe(`${sha256}.media`);
    expect(await readFile(first.absolutePath)).toEqual(contents);
    expect(await readdir(join(projectDirectory, "imports"))).toEqual([`${sha256}.media`]);
    expect(first.asset).toMatchObject({
      assetId: `asset_${sha256.slice(0, 24)}`,
      durationUs: 2_500_000,
      label: "Camera Take.MOV",
      role: "camera",
      source: {
        importedAt: NOW.toISOString(),
        kind: "imported",
        originalName: "Camera Take.MOV",
        sourceSha256: sha256,
      },
    });
    expect(first.asset.streams.map(stream => [
      stream.kind,
      stream.role,
      String(stream.streamId),
      stream.segments[0]?.streamIndex,
    ])).toEqual([
      ["video", "camera", `stream_${sha256.slice(0, 20)}_0`, 0],
      ["audio", "other", `stream_${sha256.slice(0, 20)}_2`, 2],
    ]);
    const video = first.asset.streams[0]!;
    expect(video).toMatchObject({ frameRate: 30_000 / 1_001, pixelHeight: 1_080, pixelWidth: 1_920 });
    for (const [index, stream] of first.asset.streams.entries()) {
      const expectedRange = index === 0
        ? { endUs: 2_100_000, startUs: 100_000 }
        : { endUs: 1_750_000, startUs: 250_000 };
      expect(stream.segments[0]).toEqual({
        assetRange: expectedRange,
        bytes: contents.byteLength,
        codec: stream.kind === "video" ? "h264" : "aac",
        container: "mov",
        fileRange: expectedRange,
        path: relative(repositoryRoot, first.absolutePath),
        sha256,
        streamIndex: stream.kind === "video" ? 0 : 2,
      });
    }
    expect(runner.calls).toHaveLength(3);
    const firstProbe = runner.calls[0]!;
    expect(firstProbe.argv.slice(0, -1)).toEqual([
      "/opt/homebrew/bin/ffprobe",
      "-v", "error",
      ...SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
      "-show_entries", "format=duration,format_name,start_time:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,start_time,duration:stream_disposition=attached_pic,still_image,timed_thumbnails:stream_tags=duration",
      "-of", "json",
    ]);
    expect(basename(firstProbe.argv.at(-1)!)).toMatch(/^\.import-[0-9a-f-]+\.tmp$/u);
    expect(firstProbe.options).toEqual({
      maxOutputBytes: 4 * 1_024 * 1_024,
      timeoutMs: 2 * 60_000,
    });
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("syncs staged media before publication and directory entries after publication and cleanup", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "transmute-media-durability-order-"));
  try {
    const requestedRepositoryRoot = join(temporary, "repository");
    const requestedProjectDirectory = join(
      requestedRepositoryRoot,
      "artifacts",
      "transmute",
      "projects",
      "project_durable01",
    );
    const source = join(temporary, "source.mov");
    await mkdir(requestedProjectDirectory, { recursive: true });
    const repositoryRoot = await realpath(requestedRepositoryRoot);
    const projectDirectory = await realpath(requestedProjectDirectory);
    const importsDirectory = join(projectDirectory, "imports");
    const contents = Buffer.from("durable project media\n", "utf8");
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const destinationName = `${sha256}.media`;
    await writeFile(source, contents);

    const events: {
      readonly entries: readonly string[];
      readonly kind: "directory" | "file";
      readonly path: string;
    }[] = [];
    const durability: MediaIngestDurability = {
      async syncDirectory(path) {
        const handle = await open(path, constants.O_RDONLY);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        events.push({
          entries: path === importsDirectory ? (await readdir(path)).toSorted() : [],
          kind: "directory",
          path,
        });
      },
      async syncFile(handle, path) {
        await handle.sync();
        events.push({
          entries: (await readdir(importsDirectory)).toSorted(),
          kind: "file",
          path,
        });
      },
    };

    const ingested = await ingestProjectMedia({
      durability,
      ffprobe: "ffprobe-test",
      now: NOW,
      projectDirectory,
      repositoryRoot,
      role: "camera",
      runner: new ProbeRunner(),
      sourcePath: source,
    });

    const stagedName = events.find(event => event.kind === "file")?.entries[0];
    expect(stagedName).toMatch(/^\.import-[0-9a-f-]+\.tmp$/u);
    expect(events).toEqual([
      { entries: [], kind: "directory", path: projectDirectory },
      { entries: [stagedName!], kind: "file", path: join(importsDirectory, stagedName!) },
      {
        entries: [stagedName!, destinationName].toSorted(),
        kind: "directory",
        path: importsDirectory,
      },
      { entries: [destinationName], kind: "directory", path: importsDirectory },
    ]);
    expect(ingested.created).toBe(true);
    expect(await readFile(ingested.absolutePath)).toEqual(contents);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("does not publish media when syncing the staged inode fails", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "transmute-media-durability-failure-"));
  try {
    const requestedRepositoryRoot = join(temporary, "repository");
    const requestedProjectDirectory = join(
      requestedRepositoryRoot,
      "artifacts",
      "transmute",
      "projects",
      "project_syncfail1",
    );
    const importsDirectory = join(requestedProjectDirectory, "imports");
    const source = join(temporary, "source.mov");
    await mkdir(importsDirectory, { recursive: true });
    const repositoryRoot = await realpath(requestedRepositoryRoot);
    const projectDirectory = await realpath(requestedProjectDirectory);
    await writeFile(source, "media that must not be published");
    const events: string[] = [];
    const durability: MediaIngestDurability = {
      async syncDirectory(path) {
        const handle = await open(path, constants.O_RDONLY);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        events.push("directory-sync");
      },
      syncFile() {
        events.push("file-sync");
        return Promise.reject(new Error("simulated staged-media sync failure"));
      },
    };
    const runner = new ProbeRunner();

    const failure = await rejection(ingestProjectMedia({
      durability,
      ffprobe: "ffprobe-test",
      now: NOW,
      projectDirectory,
      repositoryRoot,
      role: "camera",
      runner,
      sourcePath: source,
    }));

    expect(String(failure)).toContain("simulated staged-media sync failure");
    expect(events).toEqual(["file-sync", "directory-sync"]);
    expect(await readdir(await realpath(importsDirectory))).toEqual([]);
    expect(runner.calls).toHaveLength(0);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test.skipIf(FFMPEG === null || FFPROBE === null)(
  "probes and ingests a real VP9 and short-Opus WebM without inflating audio coverage",
  async () => {
    if (FFMPEG === null || FFPROBE === null) return;
    const temporary = await mkdtemp(join(tmpdir(), "transmute-webm-ingest-"));
    try {
      const repositoryRoot = join(temporary, "repository");
      const projectDirectory = join(repositoryRoot, "artifacts", "transmute", "projects", "project_webmprobe");
      const source = join(temporary, "short-audio.webm");
      await mkdir(projectDirectory, { recursive: true });
      const runner = new BunProcessRunner();
      const generated = await runner.run([
        FFMPEG,
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=red:s=32x24:r=10:d=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.75",
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8",
        "-c:a", "libopus",
        source,
      ], { maxOutputBytes: 64_000 });
      if (generated.exitCode !== 0) throw new Error(`Could not generate VP9/Opus fixture: ${generated.stderr}`);

      const visual = await probeVisualMediaSummary(FFPROBE, runner, source);
      expect(visual).toMatchObject({
        audioStreamIndex: 1,
        durationUs: 2_000_000,
        hasAudio: true,
        pixelHeight: 24,
        pixelWidth: 32,
        videoStreamIndex: 0,
      });
      if (visual.audioEndUs === null || visual.durationUs === null) throw new Error("Expected bounded WebM A/V durations.");
      expect(visual.audioEndUs - visual.audioStartUs).toBeGreaterThan(700_000);
      expect(visual.audioEndUs - visual.audioStartUs).toBeLessThan(900_000);
      expect(visual.audioEndUs).toBeLessThan(visual.videoStartUs + visual.durationUs);

      const ingested = await ingestProjectMedia({
        ffprobe: FFPROBE,
        now: NOW,
        projectDirectory,
        repositoryRoot,
        role: "b-roll",
        runner,
        sourcePath: source,
      });
      const video = ingested.asset.streams.find(stream => stream.kind === "video");
      const audio = ingested.asset.streams.find(stream => stream.kind === "audio");
      if (video === undefined || audio === undefined) throw new Error("Expected ingested WebM video and audio streams.");
      expect(video.segments[0]?.streamIndex).toBe(0);
      expect(audio.segments[0]?.streamIndex).toBe(1);
      expect(video.segments[0]!.assetRange.endUs - video.segments[0]!.assetRange.startUs).toBe(2_000_000);
      const audioDurationUs = audio.segments[0]!.assetRange.endUs - audio.segments[0]!.assetRange.startUs;
      expect(audioDurationUs).toBeGreaterThan(700_000);
      expect(audioDurationUs).toBeLessThan(900_000);
      expect(audioDurationUs).toBeLessThan(
        video.segments[0]!.assetRange.endUs - video.segments[0]!.assetRange.startUs,
      );
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  },
);

test("rejects symlink inputs and symlinked import directories", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "transmute-media-symlink-"));
  try {
    const requestedRepositoryRoot = join(temporary, "repository");
    const projectDirectory = join(requestedRepositoryRoot, "artifacts", "transmute", "projects", "project_symlink01");
    const source = join(temporary, "source.mov");
    const sourceLink = join(temporary, "source-link.mov");
    await mkdir(projectDirectory, { recursive: true });
    const repositoryRoot = await realpath(requestedRepositoryRoot);
    await writeFile(source, "media");
    await symlink(source, sourceLink);
    const runner = new ProbeRunner();
    const linkedSourceFailure = await rejection(ingestProjectMedia({
      ffprobe: "ffprobe-test",
      now: NOW,
      projectDirectory,
      repositoryRoot,
      role: "camera",
      runner,
      sourcePath: sourceLink,
    }));
    expect(linkedSourceFailure).toBeInstanceOf(CliError);
    expect(linkedSourceFailure).toMatchObject({ code: "unsafe-path" });
    expect(runner.calls).toHaveLength(0);

    const outsideImports = join(temporary, "outside-imports");
    await mkdir(outsideImports);
    await symlink(outsideImports, join(projectDirectory, "imports"));
    const linkedImportsFailure = await rejection(ingestProjectMedia({
      ffprobe: "ffprobe-test",
      now: NOW,
      projectDirectory,
      repositoryRoot,
      role: "camera",
      runner,
      sourcePath: source,
    }));
    expect(linkedImportsFailure).toBeInstanceOf(CliError);
    expect(linkedImportsFailure).toMatchObject({ code: "unsafe-path" });
    expect(await readdir(outsideImports)).toEqual([]);
    expect(runner.calls).toHaveLength(0);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("rejects a project directory outside the declared repository before staging or probing", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "transmute-media-project-boundary-"));
  try {
    const repositoryRoot = join(temporary, "repository");
    const projectDirectory = join(temporary, "outside-project");
    const source = join(temporary, "audio.wav");
    await Promise.all([
      mkdir(repositoryRoot),
      mkdir(projectDirectory),
      writeFile(source, "media"),
    ]);
    const runner = new ProbeRunner();

    const failure = await rejection(ingestProjectMedia({
      ffprobe: "ffprobe-test",
      now: NOW,
      projectDirectory,
      repositoryRoot,
      role: "portable-audio",
      runner,
      sourcePath: source,
    }));

    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({ code: "unsafe-path" });
    expect(runner.calls).toHaveLength(0);
    expect(await readdir(projectDirectory)).toEqual([]);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("detects corruption at an existing content-addressed destination", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "transmute-media-collision-"));
  try {
    const requestedRepositoryRoot = join(temporary, "repository");
    const projectDirectory = join(requestedRepositoryRoot, "artifacts", "transmute", "projects", "project_collision1");
    const source = join(temporary, "audio.wav");
    await mkdir(projectDirectory, { recursive: true });
    const repositoryRoot = await realpath(requestedRepositoryRoot);
    await writeFile(source, "original media bytes");
    const runner = new ProbeRunner();
    const options = {
      ffprobe: "ffprobe-test",
      now: NOW,
      projectDirectory,
      repositoryRoot,
      role: "camera" as const,
      runner,
      sourcePath: source,
    };
    const first = await ingestProjectMedia(options);
    await writeFile(first.absolutePath, "corrupt");

    const failure = await rejection(ingestProjectMedia(options));
    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({ code: "conflict" });
    expect(String(failure)).toMatch(/content-addressed media collision/iu);
    expect(runner.calls).toHaveLength(2);
    expect((await readdir(join(projectDirectory, "imports"))).some(name => name.startsWith(".import-"))).toBe(false);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("rejects a symlink prepositioned at a content-addressed destination", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "transmute-media-destination-link-"));
  try {
    const requestedRepositoryRoot = join(temporary, "repository");
    const projectDirectory = join(requestedRepositoryRoot, "artifacts", "transmute", "projects", "project_destlink1");
    const imports = join(projectDirectory, "imports");
    const source = join(temporary, "audio.wav");
    await mkdir(imports, { recursive: true });
    const repositoryRoot = await realpath(requestedRepositoryRoot);
    const contents = "original media bytes";
    await writeFile(source, contents);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await symlink(source, join(imports, `${sha256}.media`));
    const runner = new ProbeRunner();

    const failure = await rejection(ingestProjectMedia({
      ffprobe: "ffprobe-test",
      now: NOW,
      projectDirectory,
      repositoryRoot,
      role: "portable-audio",
      runner,
      sourcePath: source,
    }));
    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({ code: "unsafe-path" });
    expect(runner.calls).toHaveLength(1);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("removes staged imports after a failed probe without touching an existing content-addressed file", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "transmute-media-probe-failure-"));
  try {
    const requestedRepositoryRoot = join(temporary, "repository");
    const projectDirectory = join(requestedRepositoryRoot, "artifacts", "transmute", "projects", "project_probe_fail1");
    const imports = join(projectDirectory, "imports");
    const source = join(temporary, "audio.wav");
    await mkdir(imports, { recursive: true });
    const repositoryRoot = await realpath(requestedRepositoryRoot);
    const contents = Buffer.from("unprobeable but stable bytes", "utf8");
    await writeFile(source, contents);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const existing = join(imports, `${sha256}.media`);
    const runner = new FailingProbeRunner();
    const options = {
      ffprobe: "ffprobe-test",
      now: NOW,
      projectDirectory,
      repositoryRoot,
      role: "portable-audio" as const,
      runner,
      sourcePath: source,
    };

    const failure = await rejection(ingestProjectMedia(options));

    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({ code: "subprocess" });
    expect(await readdir(imports)).toEqual([]);

    await writeFile(existing, contents, { mode: 0o600 });
    const repeatedFailure = await rejection(ingestProjectMedia(options));
    expect(repeatedFailure).toBeInstanceOf(CliError);
    expect(repeatedFailure).toMatchObject({ code: "subprocess" });
    expect(await readFile(existing)).toEqual(contents);
    expect(await readdir(imports)).toEqual([`${sha256}.media`]);
    expect(runner.calls).toHaveLength(2);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
