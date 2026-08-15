import {
  SCENARIO_QUERY_KEY,
  type ActiveDirect,
} from "@hraness/direct";
import { Button, SearchField } from "../frontend/src/ui";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import App from "../frontend/src/App";
import { createRuntimeBridge } from "../frontend/src/runtime-bridge";
import {
  ATET_DIRECT_NOW_MS,
  atetScenarioCatalog,
  atetScenarioMetadata,
  type AtetDirectRoute,
  type AtetDirectViewport,
} from "./scenarios";
import type { MountedAtetDirect } from "./mount";
import type { AtetDirectTransportHarness } from "./transport";
import type { AtetDirectWorld } from "./world";

type Activation = ActiveDirect<AtetDirectWorld, AtetDirectRoute>;

function frameOnly(): boolean {
  return typeof globalThis.location !== "undefined"
    && new URLSearchParams(globalThis.location.search).get("directFrame") === "1";
}

function scenarioUrl(id: string, onlyFrame = false): string {
  if (typeof globalThis.location === "undefined") return `/?${SCENARIO_QUERY_KEY}=${id}`;
  const url = new URL("/", globalThis.location.origin);
  url.searchParams.set(SCENARIO_QUERY_KEY, id);
  if (onlyFrame) url.searchParams.set("directFrame", "1");
  return url.toString();
}

function formatRange(startUs: number, endUs: number): string {
  return `${(startUs / 1_000_000).toFixed(1)}–${(endUs / 1_000_000).toFixed(1)}s`;
}

function projectAssetLabel(world: AtetDirectWorld, assetId: string): string {
  return world.projectEvidence.project.assets.find((asset) => asset.assetId === assetId)?.label ?? assetId;
}

function syncLabel(placement: AtetDirectWorld["projectEvidence"]["project"]["placements"][number]): string {
  const provenance = placement.sync.provenance;
  if (provenance.kind === "audio-alignment") {
    return `accepted audio · ${Math.round(provenance.confidence * 100)}% · ${String(provenance.maxResidualUs)}µs residual`;
  }
  return provenance.kind;
}

function ProjectEvidence({ world }: { readonly world: AtetDirectWorld }) {
  const {
    acceptedAlignments,
    alignments,
    camera,
    editPlan,
    project,
  } = world.projectEvidence;
  const faceOperation = camera.operations.find(
    operation => operation.technique === "face-follow",
  );
  const faceSelection = faceOperation?.receipt.selection;
  return (
    <section aria-labelledby="project-evidence-heading" className="evidence-panel evidence-panel--wide">
      <header>
        <div>
          <p>Agent project</p>
          <h2 id="project-evidence-heading">One clock · screen + two camera/audio placements</h2>
        </div>
        <span>{(project.timeline.durationUs / 1_000_000).toFixed(1)}s · validated contracts</span>
      </header>
      <div className="project-clock" aria-label="Project timeline">
        <span>0s</span>
        <div><i style={{ width: "10%" }} /><b style={{ left: "43%", width: "1%" }} /><em style={{ left: "71%", width: "7%" }} /></div>
        <span>42s</span>
      </div>
      <div className="evidence-grid evidence-grid--three">
        {project.placements.map((placement) => {
          const asset = project.assets.find((candidate) => candidate.assetId === placement.assetId)!;
          return (
            <article key={placement.placementId}>
              <h3>{asset.role} placement</h3>
              <strong className="evidence-title">{asset.label}</strong>
              <dl className="evidence-facts">
                <div><dt>streams</dt><dd>{asset.streams.map((stream) => stream.kind).join(" + ")}</dd></div>
                <div><dt>sync</dt><dd>{syncLabel(placement)}</dd></div>
                <div><dt>anchors</dt><dd>{placement.sync.anchors.map((anchor) => `${(anchor.assetTimeUs / 1_000_000).toFixed(1)}→${(anchor.projectTimeUs / 1_000_000).toFixed(1)}`).join(" · ")}</dd></div>
              </dl>
            </article>
          );
        })}
      </div>
      <div className="evidence-grid evidence-grid--two">
        <article>
          <h3>Audio alignment candidates</h3>
          <ul>
            {alignments.flatMap((analysis) => analysis.result.status === "no-match" ? [] : analysis.result.candidates.map((candidate) => {
              const accepted = acceptedAlignments.some((decision) => decision.candidateId === candidate.candidateId);
              return (
                <li key={candidate.candidateId}>
                  <strong>{accepted ? "accepted" : "retained"} · {(candidate.initialOffsetUs / 1_000_000).toFixed(3)}s</strong>
                  <span>{Math.round(candidate.confidence * 100)}% · drift {candidate.driftPpm}ppm</span>
                </li>
              );
            }))}
          </ul>
        </article>
        <article>
          <h3>Global synchronized edit plan</h3>
          <ul>
            <li><strong>keep</strong><span>{editPlan.keep.map((range) => formatRange(range.startUs, range.endUs)).join(" · ")}</span></li>
            <li><strong>cut all placements</strong><span>{editPlan.derivations.filter(({ operation }) => operation === "cut").map(({ projectRange }) => formatRange(projectRange.startUs, projectRange.endUs)).join(" · ")}</span></li>
            <li><strong>speed all placements</strong><span>{editPlan.speed.map(({ range, rate }) => `${formatRange(range.startUs, range.endUs)} @ ${rate}×`).join(" · ")}</span></li>
            <li><strong>project time</strong><span>edit once · render every angle in sync</span></li>
          </ul>
        </article>
      </div>
      <div className="evidence-grid evidence-grid--two">
        <article>
          <h3>Camera motion receipts</h3>
          <ul>
            {camera.operations.map((operation) => {
              const move = editPlan.cameraMoves.find(
                candidate => candidate.cameraMoveId === operation.receipt.cameraMoveId,
              )!;
              const label = operation.technique === "ken-burns-digital-pan-zoom"
                ? "Ken Burns · digital pan + zoom"
                : "Face-follow · explicit multi-face";
              return (
                <li key={operation.receipt.cameraMoveId}>
                  <strong>{label}</strong>
                  <span>
                    {operation.receipt.cameraMoveId} · {operation.receipt.keyframeCount} keyframes
                    {" · "}
                    {formatRange(move.projectRange.startUs, move.projectRange.endUs)}
                  </span>
                </li>
              );
            })}
            <li>
              <strong>{editPlan.cameraMoves.length} camera moves</strong>
              <span>stable IDs · show/remove next commands</span>
            </li>
          </ul>
        </article>
        <article>
          <h3>Face-follow provenance</h3>
          <ul>
            <li>
              <strong>explicit {faceSelection?.trackIds.length ?? 0}-face group</strong>
              <span>require all selected · geometry track IDs</span>
            </li>
            <li>
              <strong>gap policy</strong>
              <span>
                {faceOperation?.technique === "face-follow"
                  && faceOperation.gapPolicy.kind === "hold"
                  ? `hold up to ${(faceOperation.gapPolicy.maximumHoldUs / 1_000_000).toFixed(1)}s · then ${faceOperation.gapPolicy.whenExpired}`
                  : "not configured"}
              </span>
            </li>
            <li>
              <strong>{camera.faceAnalysis.analysisId}</strong>
              <span>
                {camera.faceAnalysis.coverage.analyzedFrames} local frames
                {" · "}
                {camera.faceAnalysis.tracks.length} geometry tracks
              </span>
            </li>
            <li>
              <strong>local geometry only</strong>
              <span>bounding boxes · geometry continuity · no biometric identification</span>
            </li>
          </ul>
        </article>
      </div>
    </section>
  );
}

const PITCH_CLASSES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"] as const;

function AnalysisEvidence({ world }: { readonly world: AtetDirectWorld }) {
  const { fillerDecisions, music, provenance, scenes, speech } = world.projectEvidence;
  const fillers = speech.result.status === "transcribed" ? speech.result.fillers : [];
  return (
    <section aria-labelledby="analysis-evidence-heading" className="evidence-panel evidence-panel--wide">
      <header>
        <div>
          <p>Agent analysis</p>
          <h2 id="analysis-evidence-heading">Compact local evidence ledger</h2>
        </div>
        <span>fixture · no Python · no cloud execution</span>
      </header>
      <div className="boundary-note">
        <strong>{provenance.localBoundaryDetector}</strong>
        <span>PySceneDetect is a reference, not a dependency · local boundary evidence: {provenance.localBoundaryEvidence} · selected frames only</span>
      </div>
      <div className="evidence-grid evidence-grid--three">
        <article>
          <h3>Music structure</h3>
          <ul>
            {music.musicRegions.map((region) => <li key={region.range.startUs}><strong>music present</strong><span>{formatRange(region.range.startUs, region.range.endUs)} · {Math.round(region.confidence * 100)}%</span></li>)}
            {music.tempoRegions.map((region) => <li key={region.range.startUs}><strong>{region.bpm} BPM</strong><span>{region.changeFromPrevious === null ? "initial tempo" : `tempo change +${region.changeFromPrevious.deltaBpm}`}</span></li>)}
            {music.keyRegions.map((region) => <li key={region.range.startUs}><strong>{region.key.kind === "key" ? `${PITCH_CLASSES[region.key.pitchClass]} ${region.key.mode}` : "unknown key"}</strong><span>{formatRange(region.range.startUs, region.range.endUs)}</span></li>)}
          </ul>
        </article>
        <article className="scene-card">
          <h3>Screen + camera scenes</h3>
          <ul>
            {scenes.flatMap((analysis) => analysis.scenes.map((scene) => (
              <li key={scene.sceneId}>
                <strong>{scene.description.title}</strong>
                <span>{projectAssetLabel(world, analysis.subjects[0]!.assetId)} · {scene.description.summary}</span>
              </li>
            )))}
          </ul>
          <small>{scenes.reduce((total, analysis) => total + analysis.samples.length, 0)} selected local frames · descriptions marked untrusted fixture output</small>
        </article>
        <article>
          <h3>Speech filler decisions</h3>
          <ul>
            {fillers.map((filler) => {
              const decision = fillerDecisions.find((candidate) => candidate.candidateId === filler.candidateId);
              const status = decision?.status === "projected"
                ? `safe cut → ${formatRange(decision.projectRange.startUs, decision.projectRange.endUs)} project time`
                : decision?.reason === "music-protected"
                  ? "kept · music-protected"
                  : "kept · contextual / unsafe";
              return <li key={filler.candidateId}><strong>“{filler.text}” · {filler.classification}</strong><span>{status}</span></li>;
            })}
          </ul>
        </article>
      </div>
    </section>
  );
}

function overlaySourceDetails(overlay: AtetDirectWorld["projectEvidence"]["editPlan"]["overlays"][number]): string {
  const source = overlay.source;
  if (source.kind === "gif") return `${source.playback.playbackRate}× · ${source.playback.endBehavior} · muted`;
  if (source.kind === "video") {
    const audio = source.audioPolicy.kind === "mute"
      ? "muted"
      : source.audioPolicy.kind === "mix"
        ? `mix ${source.audioPolicy.volume}×`
        : `duck primary to ${source.audioPolicy.duckPrimaryTo} · ${source.audioPolicy.volume}×`;
    return `${source.playback.playbackRate}× · ${source.playback.endBehavior} · ${audio}`;
  }
  if (source.kind === "emoji") return `${source.provider} · ${source.selector.kind}:${source.selector.value}`;
  return source.asset.mediaType;
}

function OverlayEvidence({ world }: { readonly world: AtetDirectWorld }) {
  const overlays = world.projectEvidence.editPlan.overlays;
  return (
    <section aria-labelledby="overlay-evidence-heading" className="evidence-panel evidence-panel--wide">
      <header>
        <div>
          <p>Agent compositor</p>
          <h2 id="overlay-evidence-heading">Image · SVG · GIF · video · emoji</h2>
        </div>
        <span>fully structured controls · project time</span>
      </header>
      <div className="overlay-control-grid">
        {overlays.map((overlay) => (
          <article key={overlay.overlayId}>
            <header><strong>{overlay.source.kind}</strong><span>z {overlay.zIndex}</span></header>
            <p>{formatRange(overlay.range.startUs, overlay.range.endUs)} · {overlaySourceDetails(overlay)}</p>
            <dl className="evidence-facts">
              <div><dt>layout</dt><dd>{overlay.anchor} · {overlay.fit} · {overlay.size.kind}</dd></div>
              <div><dt>visual</dt><dd>{overlay.blendMode} · crop {overlay.crop.kind} · mask {overlay.mask.kind}</dd></div>
              <div><dt>transform</dt><dd>{overlay.scale}× · {overlay.rotationDegrees}° · {Math.round(overlay.opacity * 100)}%</dd></div>
              <div><dt>motion</dt><dd>{overlay.motion.kind} · {overlay.entrance.kind} in · {overlay.exit.kind} out</dd></div>
            </dl>
          </article>
        ))}
      </div>
      <div className="boundary-note">
        <strong>Overlay control surface</strong>
        <span>fit · crop · mask · blend · opacity · scale · rotation · position · z-index · keyframes · entrance/exit · playback · audio policy · emoji set</span>
      </div>
    </section>
  );
}

function WorkflowEvidence({ world }: { readonly world: AtetDirectWorld }) {
  const evidence = world.workflowEvidence;
  const recovered = evidence.runs.at(-1)!;
  return (
    <section
      aria-labelledby="workflow-evidence-heading"
      className="evidence-panel evidence-panel--wide"
    >
      <header>
        <div>
          <p>Agent workflow</p>
          <h2 id="workflow-evidence-heading">Compiled graph · parallel waves · durable replay</h2>
        </div>
        <span>{evidence.workflowId} · {evidence.graphPlanSha256.slice(0, 12)}</span>
      </header>
      <div className="boundary-note">
        <strong>Production compiler evidence</strong>
        <span>{evidence.nodes.length} nodes · {evidence.waves.length} waves · effects {evidence.effects.join(" + ")}</span>
      </div>
      <div aria-label="Workflow topological waves" className="workflow-waves">
        {evidence.waves.map((wave, index) => (
          <article key={wave.join("-")}>
            <span>wave {index + 1}</span>
            <div>
              {wave.map((nodeKey) => {
                const node = evidence.nodes.find(({ key }) => key === nodeKey)!;
                return (
                  <strong key={nodeKey}>
                    {node.key}
                    <small>
                      {node.executor.kind === "compute"
                        ? `trusted · ${node.executor.computeKey}`
                        : node.executor.operation}
                    </small>
                  </strong>
                );
              })}
            </div>
          </article>
        ))}
      </div>
      <div className="evidence-grid evidence-grid--two">
        {evidence.runs.map((run) => (
          <article key={run.label}>
            <h3>{run.label}</h3>
            <strong className="evidence-title">
              {run.summary.status} · {run.summary.counts.completed}/{evidence.nodes.length} complete
            </strong>
            <ul>
              {run.nodes.map((node) => (
                <li key={node.key}>
                  <strong>{node.key}</strong>
                  <span>{node.status} · attempt {node.attempt}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      <div className="evidence-grid evidence-grid--two">
        <article>
          <h3>Exact recovery grant</h3>
          <strong className="evidence-title">
            {evidence.recovery.failedNode} · {evidence.recovery.replayScope}
          </strong>
          <code className="workflow-command">{evidence.recovery.command}</code>
        </article>
        <article>
          <h3>Durable run files</h3>
          <strong className="evidence-title">
            {recovered.summary.status} · exact graph and output digests
          </strong>
          <ul>
            <li>
              <strong>graph plan</strong>
              <span>
                {evidence.graphPlanSha256.slice(0, 10)} · {evidence.durableRun.graphPlanPath}
              </span>
            </li>
            <li>
              <strong>run summary</strong>
              <span>{recovered.summary.status} · {evidence.durableRun.summaryPath}</span>
            </li>
            <li>
              <strong>run outputs</strong>
              <span>
                {evidence.durableRun.outputsDocument.outputsSha256.slice(0, 10)}
                {" · "}
                {evidence.durableRun.outputsPath}
              </span>
            </li>
          </ul>
        </article>
      </div>
    </section>
  );
}

function EditEvidence({ world }: { readonly world: AtetDirectWorld }) {
  return (
    <section aria-labelledby="evidence-heading" className="evidence-panel">
      <header>
        <div>
          <p>Agent projection</p>
          <h2 id="evidence-heading">Structured edit evidence</h2>
        </div>
        <span>fixture · no FFmpeg</span>
      </header>
      <div className="evidence-grid">
        <article>
          <h3>Analyzer</h3>
          <ul>
            {world.editEvidence.analyzer.map((range) => (
              <li key={`${range.kind}-${String(range.startUs)}`}>
                <strong>{range.kind}</strong>
                <span>{formatRange(range.startUs, range.endUs)} · {Math.round(range.confidence * 100)}%</span>
              </li>
            ))}
          </ul>
        </article>
        <article>
          <h3>Metadata</h3>
          <ul>
            {world.editEvidence.metadata.map((event, index) => (
              <li key={`${event.kind}-${String(event.timeUs)}-${String(index)}`}>
                <strong>{event.kind}</strong>
                <span>{(event.timeUs / 1_000_000).toFixed(1)}s</span>
              </li>
            ))}
          </ul>
        </article>
        <article>
          <h3>Edit plan</h3>
          <ul>
            {world.editEvidence.edits.map((edit) => (
              <li key={`${edit.kind}-${String(edit.startUs)}`}>
                <strong>{edit.kind}</strong>
                <span>{formatRange(edit.startUs, edit.endUs)}</span>
              </li>
            ))}
          </ul>
        </article>
        <article>
          <h3>Overlays</h3>
          <div className="overlay-kinds">
            {world.editEvidence.overlays.map((overlay) => (
              <span key={overlay.id}>{overlay.kind}</span>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}

function RecorderFixture({
  activation,
  harness,
}: {
  readonly activation: Activation;
  readonly harness: AtetDirectTransportHarness;
}) {
  const bridge = useMemo(() => {
    let sequence = 0;
    return createRuntimeBridge(harness.transport, {
      createRequestId: () => `request_direct${String(++sequence).padStart(4, "0")}`,
    });
  }, [harness]);
  const focus = atetScenarioMetadata[activation.scenario]?.focus ?? "capture";
  return (
    <div className="fixture-content">
      <App bridge={bridge} now={() => ATET_DIRECT_NOW_MS} />
      {focus === "capture" ? <EditEvidence world={activation.world} /> : null}
      {focus === "project" ? <ProjectEvidence world={activation.world} /> : null}
      {focus === "analysis" ? <AnalysisEvidence world={activation.world} /> : null}
      {focus === "overlays" ? <OverlayEvidence world={activation.world} /> : null}
      {focus === "workflow" ? <WorkflowEvidence world={activation.world} /> : null}
    </div>
  );
}

function Frame({
  activation,
  children,
}: {
  readonly activation: Activation;
  readonly children: ReactNode;
}) {
  const [viewport, setViewport] = useState<AtetDirectViewport>(
    atetScenarioMetadata[activation.scenario]?.viewport ?? "wide",
  );
  const [query, setQuery] = useState("");
  if (frameOnly()) {
    return (
      <div
        aria-label={`Direct ready: ${activation.scenario}`}
        className="direct-frame-only"
        data-direct-scenario={activation.scenario}
      >
        {children}
      </div>
    );
  }

  const normalized = query.trim().toLowerCase();
  const scenarios = atetScenarioCatalog.list().filter((scenario) => (
    normalized.length === 0
    || scenario.id.includes(normalized)
    || scenario.title.toLowerCase().includes(normalized)
    || scenario.description?.toLowerCase().includes(normalized)
  ));
  const dimensions = viewport === "wide"
    ? { height: 900, width: 1_120 }
    : { height: 820, width: 560 };
  const selected = atetScenarioCatalog.get(activation.scenario);

  return (
    <div
      aria-label={`Direct ready: ${activation.scenario}`}
      className="direct-workbench"
      data-direct-scenario={activation.scenario}
    >
      <aside className="direct-sidebar">
        <header>
          <p>Atet · Direct</p>
          <h1>Atet lab</h1>
          <span>Real UI · deterministic recorder · no devices</span>
        </header>
        <SearchField
          className="direct-search"
          label="Search scenarios"
          onChange={setQuery}
          placeholder="Search scenarios"
          size="compact"
          surface="pane"
          value={query}
        />
        <nav aria-label="Direct scenarios">
          {scenarios.map((scenario) => (
            <a
              aria-current={scenario.id === activation.scenario ? "page" : undefined}
              data-active={scenario.id === activation.scenario || undefined}
              href={scenarioUrl(scenario.id)}
              key={scenario.id}
            >
              <small>{atetScenarioMetadata[scenario.id]?.group ?? "Capture"}</small>
              <strong>{scenario.title}</strong>
            </a>
          ))}
        </nav>
      </aside>
      <main className="direct-stage">
        <header className="direct-toolbar">
          <div>
            <strong>{selected?.title ?? activation.scenario}</strong>
            <span>{selected?.description}</span>
          </div>
          <div className="direct-actions">
            {(["compact", "wide"] as const).map((candidate) => (
              <Button
                data-active={viewport === candidate || undefined}
                key={candidate}
                onPress={() => setViewport(candidate)}
                size="compact"
                type="button"
                variant={viewport === candidate ? "primary" : "quiet"}
              >
                {candidate}
              </Button>
            ))}
            <a href={scenarioUrl(activation.scenario, true)} target="_blank">open frame</a>
          </div>
        </header>
        <div className="direct-scroll">
          <div className="direct-desktop" style={{ height: dimensions.height, width: dimensions.width }}>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

export function AtetDirectWorkbench({
  mounted,
}: {
  readonly mounted: MountedAtetDirect;
}) {
  const { activation, harness } = mounted.session;
  const mounts = useRef(0);
  useEffect(() => {
    mounts.current += 1;
    return () => {
      queueMicrotask(() => {
        mounts.current -= 1;
        if (mounts.current === 0) mounted.dispose();
      });
    };
  }, [mounted]);

  return (
    <Frame activation={activation}>
      <RecorderFixture activation={activation} harness={harness} />
    </Frame>
  );
}

export function AtetDirectError({ message }: { readonly message: string }) {
  return (
    <main className="direct-error" role="alert">
      <p>Atet · Direct</p>
      <h1>Activation failed</h1>
      <code>{message}</code>
    </main>
  );
}
