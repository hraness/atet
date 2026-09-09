import { join, resolve } from "node:path";
import { ZodError } from "zod";

import type { ApplicationContext } from "../application/context";
import { DIRECTING_LIMITS, directingRequestId, type DirectingAttempt, type DirectingRecipe, type DirectingState } from "../application/directing-contract";
import {
  activeDirectingSelections, attachDirectingEndpoint, buildDirectingTimeline,
  completeDirectingAttempt, createDirectingState, directingRecipeSha256,
  parseDirectingRecipe, parseDirectingState, reserveDirectingAttempt,
  resolveDirectingShot, reviewDirectingAttempt, reviseDirectingRecipe,
  settleDirectingAttempt, totalDirectingReservedMicroUsd,
} from "../application/directing-plan";
import {
  dispatchGatewayOperation, GatewayVideoOperationResultSchema,
  prepareGatewayOperation, reconcileGatewayOperation,
  type GatewayPortRequest,
} from "../application/gateway-port";
import { canonicalJson, canonicalJsonSha256 } from "../core/canonical-json";
import { createNodeBundleFileSystem } from "../core/storage";
import type { DirectingCommand } from "./args";
import type { createDirectingBlobSession } from "./directing-blob";
import { assembleDirectingClips, extractDirectingEndpoint, importDirectingAnchor } from "./directing-media";
import { directingInputTransport, parseDirectingUsd, quoteDirectingShot } from "./directing-quote";
import { CliError } from "./errors";
import { GatewayMediaExecutionError } from "./gateway-media-service";
import { GatewayCredentialError } from "./gateway-credential";
import type { GatewayMediaCatalogView } from "./gateway-media-catalog";
import { withMutationLock } from "./mutation-lock";
import { ensurePhysicalPrivateDirectoryWithin, ensurePrivateDirectory } from "./paths";
import { publishSpatialSource, readSpatialJson } from "./spatial-scene-service";

export interface DirectingServiceAdapters {
  readonly catalog: { get(input: { forceRefresh: boolean; freshness: "require-fresh"; signal: AbortSignal }): Promise<GatewayMediaCatalogView> };
  readonly signal?: AbortSignal;
  readonly createReferenceHosting?: (directingId: string, attemptId: string, signal: AbortSignal) => ReturnType<typeof createDirectingBlobSession>;
  readonly media?: {
    readonly anchor: typeof importDirectingAnchor;
    readonly endpoint: typeof extractDirectingEndpoint;
    readonly assemble: typeof assembleDirectingClips;
  };
}

const STATE_FILE = "state.json";
const BUDGET_NOTICE = "USD amounts are retained catalog estimates, not settled invoices or a provider-enforced spending cap. Every dispatched or ambiguous take keeps its reservation. Gateway may make multiple provider attempts; client retries are disabled.";

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CliError("cancelled", "Directing command interrupted; inspect or resume the retained take before continuing.");
}
function currentRecipe(state: DirectingState): DirectingRecipe {
  return state.recipes.find(value => value.sha256 === state.activeRecipeSha256)!.recipe;
}
function snapshot(state: DirectingState) {
  const active = activeDirectingSelections(state), reservedMicroUsd = totalDirectingReservedMicroUsd(state);
  return {
    id: state.id, recipeSha256: state.activeRecipeSha256,
    budget: { maximumMicroUsd: state.budgetMicroUsd, reservedMicroUsd, remainingMicroUsd: state.budgetMicroUsd - reservedMicroUsd, notice: BUDGET_NOTICE },
    shots: currentRecipe(state).shots.map(shot => ({
      id: shot.id, prompt: shot.prompt, model: shot.model,
      selectedAttempt: Object.hasOwn(state.selections, shot.id) ? state.selections[shot.id] : null,
      selectionStatus: Object.hasOwn(active, shot.id) ? "accepted" : Object.hasOwn(state.selections, shot.id) ? "stale" : "unselected",
    })),
    attempts: state.attempts.map(attempt => ({
      id: attempt.id, shotId: attempt.shotId, state: attempt.state,
      reservedMicroUsd: attempt.state === "not-dispatched" ? 0 : attempt.quote.costMicroUsd,
      requestId: attempt.requestId, dependencies: attempt.dependencies,
      ...(attempt.state === "completed" ? { outputs: attempt.result.outputs, receipt: attempt.result.receipt, endpoint: attempt.endpoint ?? null, review: attempt.review ?? null } : {}),
    })),
    nextCommands: [`atet direct inspect ${state.id} --json`, `atet direct assemble ${state.id} --json`],
  };
}

async function directoryFor(application: ApplicationContext, id: string): Promise<string> {
  if (!/^direct_[a-z][a-z0-9_-]{0,63}$/u.test(id)) throw new CliError("usage", "Expected the exact direct_<id> identifier.");
  await ensurePrivateDirectory(application.paths.privateRoot);
  const root = await ensurePhysicalPrivateDirectoryWithin(application.paths.privateRoot, "directing");
  return await ensurePhysicalPrivateDirectoryWithin(root, id);
}
async function readState(directory: string): Promise<DirectingState> {
  return parseDirectingState(await readSpatialJson(join(directory, STATE_FILE), DIRECTING_LIMITS.stateBytes));
}

async function executeDirectingCommandBody(
  application: ApplicationContext,
  command: DirectingCommand,
  adapters: DirectingServiceAdapters,
): Promise<unknown> {
  const signal = adapters.signal ?? new AbortController().signal;
  const media = adapters.media ?? { anchor: importDirectingAnchor, endpoint: extractDirectingEndpoint, assemble: assembleDirectingClips };
  const recipeAt = async (path: string) => parseDirectingRecipe(await readSpatialJson(resolve(application.paths.repositoryRoot, path), 8 * 1024 * 1024));
  aborted(signal);
  if (command.action === "init") {
    const recipe = parseDirectingRecipe({
      kind: "atet.directing-recipe", schemaVersion: 1, id: "direct_film", title: "Untitled film",
      shots: [{ id: "opening", model: "minimax/minimax-h3-max", prompt: "Replace this with the shot you want to direct.", durationSeconds: 5, resolution: "480p", aspectRatio: "16:9", fps: 24 }],
    });
    const path = resolve(application.paths.repositoryRoot, command.path);
    await publishSpatialSource(path, recipe, async () => aborted(signal));
    return { path, recipeSha256: directingRecipeSha256(recipe), nextCommand: `atet direct plan ${JSON.stringify(command.path)} --json` };
  }
  if (command.action === "anchor") return await media.anchor(application, command.input, signal);
  if (command.action === "plan") {
    const recipe = await recipeAt(command.recipe);
    const catalog = await adapters.catalog.get({ forceRefresh: true, freshness: "require-fresh", signal });
    const shots = recipe.shots.map(shot => ({ shotId: shot.id, quote: quoteDirectingShot(catalog, shot, application.clock.now()), inputTransport: directingInputTransport(catalog, shot), continuity: shot.firstFrame?.kind === "shot-end" ? { requiresAcceptedShot: shot.firstFrame.shotId } : null }));
    return { id: recipe.id, recipeSha256: directingRecipeSha256(recipe), shots, firstPassMicroUsd: shots.reduce((sum, shot) => sum + shot.quote.costMicroUsd, 0), notice: BUDGET_NOTICE };
  }
  if (command.action === "start") {
    const recipe = await recipeAt(command.recipe);
    const directory = await directoryFor(application, recipe.id);
    return await withMutationLock(directory, { command: "direct start", label: `Directing ${recipe.id}` }, async lease => {
      const state = createDirectingState(recipe, parseDirectingUsd(command.budgetUsd));
      await lease.assertOwned();
      const created = await createNodeBundleFileSystem(directory).writeTextNoReplace?.(STATE_FILE, `${canonicalJson(state)}\n`, async () => { aborted(signal); await lease.assertOwned(); });
      if (created !== "created") throw new CliError("conflict", "This directing ID already has a retained budget. Inspect it or revise its recipe; starting again cannot reset spending.");
      return snapshot(state);
    });
  }
  const directory = await directoryFor(application, command.id);
  if (command.action === "inspect") return snapshot(await readState(directory));
  return await withMutationLock(directory, { command: `direct ${command.action}`, label: `Directing ${command.id}` }, async lease => {
    let state = await readState(directory);
    if (state.id !== command.id) throw new CliError("conflict", "The directing directory and retained identity differ.");
    const save = async (next: DirectingState): Promise<void> => {
      await lease.assertOwned();
      const parsed = parseDirectingState(next);
      await createNodeBundleFileSystem(directory).writeTextAtomicGuarded!(STATE_FILE, `${canonicalJson(parsed)}\n`, () => lease.assertOwned());
      state = parsed;
    };
    const findAttempt = (id: string): DirectingAttempt => {
      const value = state.attempts.find(attempt => attempt.id === id);
      if (value === undefined) throw new CliError("not-found", "No retained take has this exact ID.");
      return value;
    };
    const finishEndpoint = async (attemptId: string): Promise<void> => {
      const attempt = findAttempt(attemptId);
      if (attempt.state !== "completed") return;
      // Reconciliation verifies the authoritative receipt and video even on reuse.
      const reconciled = await reconcileGatewayOperation(application, { request: attempt.request, requestId: attempt.requestId, signal });
      if (reconciled.status !== "completed") throw new CliError("conflict", "Completed directing media no longer matches its authoritative Gateway receipt.");
      completeDirectingAttempt(state, attemptId, GatewayVideoOperationResultSchema.parse(reconciled.result));
      const endpoint = await media.endpoint(application, attempt.result.outputs[0]!, "last", signal);
      const next = attachDirectingEndpoint(state, attemptId, endpoint);
      if (attempt.endpoint === undefined) await save(next);
    };
    const reconcile = async (attemptId: string): Promise<void> => {
      const attempt = findAttempt(attemptId);
      const result = await reconcileGatewayOperation(application, { request: attempt.request, requestId: attempt.requestId, signal });
      if (result.status === "completed") {
        await save(completeDirectingAttempt(state, attemptId, GatewayVideoOperationResultSchema.parse(result.result)));
        await finishEndpoint(attemptId);
      } else if (attempt.state === "completed") {
        throw new CliError("conflict", "Retained completion no longer verifies; no budget was released.");
      } else if (result.status === "not-dispatched" && attempt.state === "not-dispatched") {
        // Only a previously retained, proven non-dispatch can stay released.
        // A missing journal after restart cannot prove a reserved take was never sent.
        return;
      } else {
        await save(settleDirectingAttempt(state, attemptId, "ambiguous", result.status));
        throw new CliError("ambiguous", "This take may have been charged. Its reservation remains held; resume only checks retained local receipts and never resubmits a provider call.");
      }
    };
    if (command.action === "cleanup") {
      findAttempt(command.attempt);
      if (adapters.createReferenceHosting === undefined) throw new CliError("unavailable", "Reference hosting is not configured.");
      return await (await adapters.createReferenceHosting(state.id, command.attempt, signal)).cleanup();
    }
    if (command.action === "revise") {
      await save(reviseDirectingRecipe(state, await recipeAt(command.recipe)));
    } else if (command.action === "resume") {
      await reconcile(command.attempt);
    } else if (command.action === "review") {
      if (command.decision === "accepted") await finishEndpoint(command.attempt);
      await save(reviewDirectingAttempt(state, command.attempt, command.decision, command.note));
    } else if (command.action === "assemble") {
      const clips = buildDirectingTimeline(state);
      for (const clip of clips) await finishEndpoint(clip.attemptId);
      aborted(signal);
      await lease.assertOwned();
      const assembled = await media.assemble(application, { id: state.id, title: currentRecipe(state).title, clips: clips.map(({ shotId, attemptId, source, durationUs }) => ({ shotId, attemptId, source, durationUs })), recipeSha256: state.activeRecipeSha256 }, signal);
      return { ...assembled, nextCommand: `atet project render run ${assembled.projectId} --width 1280 --height 720 --fps 24 --output renders/directed-film.mp4 --json` };
    } else if (command.action === "generate") {
      const prior = state.attempts.find(attempt => attempt.id === command.attempt);
      if (prior !== undefined) {
        const resolved = resolveDirectingShot(state, command.shot);
        if (prior.shotId !== command.shot || prior.shotSha256 !== resolved.shotSha256) throw new CliError("conflict", "This take ID is already bound to different shot input. Choose a new take ID for a deliberate new request.");
        await reconcile(command.attempt);
        return snapshot(state);
      }
      const dependencies = resolveDirectingShot(state, command.shot).dependencies;
      for (const dependency of dependencies) await finishEndpoint(dependency.attemptId);
      const resolved = resolveDirectingShot(state, command.shot), shot = resolved.shot;
      if ((resolved.firstFrame !== undefined || resolved.lastFrame !== undefined) && !command.allowCloudUpload) throw new CliError("authorization-required", "This take uploads its exact retained image references. Supply --allow-cloud-upload for this request.");
      const catalog = await adapters.catalog.get({ forceRefresh: true, freshness: "require-fresh", signal });
      const quote = quoteDirectingShot(catalog, shot, application.clock.now());
      const needsHosting = directingInputTransport(catalog, shot) === "url";
      if (needsHosting && (!command.allowReferenceHosting || adapters.createReferenceHosting === undefined)) throw new CliError("authorization-required", "This model requires image URLs. Configure a private Vercel Blob store and supply --allow-reference-hosting for expiring access to these exact reference frames; --allow-cloud-upload is also required.");
      if (quote.costMicroUsd > state.budgetMicroUsd - totalDirectingReservedMicroUsd(state)) throw new CliError("authorization-required", "This take exceeds the remaining directing budget. No paid request was dispatched.");
      const request = await prepareGatewayOperation(application, {
        signal,
        request: { operation: "video", request: {
          model: shot.model, prompt: shot.prompt, durationSeconds: shot.durationSeconds,
          resolution: shot.resolution, aspectRatio: shot.aspectRatio, n: 1, maxVideosPerCall: 1,
          timeoutMs: 10 * 60_000,
          ...(shot.fps === undefined ? {} : { fps: shot.fps }),
          ...(shot.seed === undefined ? {} : { seed: shot.seed }),
          ...(resolved.firstFrame === undefined ? {} : { frames: [
            { frameType: "first_frame" as const, source: resolved.firstFrame },
            ...(resolved.lastFrame === undefined ? [] : [{ frameType: "last_frame" as const, source: resolved.lastFrame }]),
          ] }),
        } },
      });
      const requestId = directingRequestId({ id: state.id, attemptId: command.attempt, recipeSha256: state.activeRecipeSha256, shotSha256: resolved.shotSha256, request });
      await save(reserveDirectingAttempt(state, {
        id: command.attempt, recipeSha256: state.activeRecipeSha256, shotId: shot.id,
        shotSha256: resolved.shotSha256, requestId, request, quote, state: "reserved", dependencies: resolved.dependencies,
      }));
      let hosting: Awaited<ReturnType<typeof createDirectingBlobSession>> | undefined;
      const generation = await (async () => {
        try {
          hosting = needsHosting ? await adapters.createReferenceHosting!(state.id, command.attempt, signal) : undefined;
          aborted(signal);
          const result = GatewayVideoOperationResultSchema.parse(await dispatchGatewayOperation(application, {
            request: request as GatewayPortRequest, requestId, signal,
            ...(hosting === undefined ? {} : { resolveSourceUrl: hosting.resolveSourceUrl }),
            beforeDispatch: async () => {
              aborted(signal);
              await lease.assertOwned();
              const current = await readState(directory);
              if (canonicalJsonSha256(current) !== canonicalJsonSha256(state)) throw new CliError("conflict", "The directing reservation changed before dispatch.");
              quoteDirectingShot(catalog, shot, application.clock.now());
            },
            beforePublication: async () => { aborted(signal); await lease.assertOwned(); },
          }));
          await save(completeDirectingAttempt(state, command.attempt, result));
        } catch (error) {
          // Use an uncancelled, local-only read to retain charge ambiguity on abort.
          const attempt = findAttempt(command.attempt);
          const recovered = await reconcileGatewayOperation(application, { request: attempt.request, requestId, signal: new AbortController().signal }).catch(() => undefined);
          if (recovered?.status === "completed") {
            await save(completeDirectingAttempt(state, command.attempt, GatewayVideoOperationResultSchema.parse(recovered.result)));
          } else {
            const undispatched = recovered?.status === "not-dispatched";
            const reason = error instanceof GatewayMediaExecutionError || error instanceof GatewayCredentialError || error instanceof CliError ? error.code : "pre-dispatch-failure";
            await save(settleDirectingAttempt(state, command.attempt, undispatched ? "not-dispatched" : "ambiguous", undispatched ? reason : "unresolved-dispatch"));
            throw new CliError(undispatched ? "unavailable" : "ambiguous", undispatched ? `The take failed before dispatch (${reason}); its reservation was released. Inspect model access and use a new take ID for a deliberate retry.` : "The take may have been charged. Its reservation remains held. Resume can recover completed local receipts; it never resubmits the provider call.", hosting === undefined ? undefined : { referenceHostingReceipt: hosting.receiptPath, cleanupCommand: `atet direct cleanup ${state.id} --attempt ${command.attempt} --json` });
          }
        }
      })().then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      let referenceHosting: { receiptPath: string; cleanupRequired: boolean; cleanupCommand: string; receipt?: Awaited<ReturnType<NonNullable<typeof hosting>["inspect"]>> } | undefined;
      if (hosting !== undefined) {
        const retained = findAttempt(command.attempt);
        let receipt: Awaited<ReturnType<typeof hosting.inspect>> | undefined;
        // An ambiguous remote job may still read its reference after the client stops.
        try {
          receipt = retained.state === "completed" || retained.state === "not-dispatched"
            ? await hosting.cleanup() : await hosting.inspect();
        } catch { /* Retain a recovery command even when the cleanup ledger cannot be read. */ }
        referenceHosting = {
          receiptPath: hosting.receiptPath,
          cleanupRequired: receipt === undefined || receipt.entries.some(entry => entry.cleanup !== "deleted"),
          cleanupCommand: `atet direct cleanup ${state.id} --attempt ${command.attempt} --json`,
          ...(receipt === undefined ? {} : { receipt }),
        };
      }
      const withHostingEvidence = (error: unknown): unknown => {
        if (referenceHosting === undefined) return error;
        const known = error instanceof CliError;
        return new CliError(known ? error.code : "internal", known ? error.message : "Local directing completion failed; inspect the retained take before retrying.", { referenceHosting });
      };
      if (!generation.ok) throw withHostingEvidence(generation.error);
      try { await finishEndpoint(command.attempt); }
      catch (error) { throw withHostingEvidence(error); }
      return { ...snapshot(state), ...(referenceHosting === undefined ? {} : { referenceHosting }) };
    }
    return snapshot(state);
  });
}

/** Keep invalid authored data and stale selections distinct from internal faults. */
export async function executeDirectingCommand(application: ApplicationContext, command: DirectingCommand, adapters: DirectingServiceAdapters): Promise<unknown> {
  try { return await executeDirectingCommandBody(application, command, adapters); }
  catch (error) {
    if (error instanceof ZodError) throw new CliError("invalid-data", "Directing data does not match the recipe or retained-state contract.", { issues: error.issues.slice(0, 8).map(issue => ({ path: issue.path, message: issue.message })) });
    if (error instanceof RangeError) throw new CliError("conflict", error.message);
    if (error instanceof SyntaxError) throw new CliError("invalid-data", "Directing input must be valid bounded JSON.");
    throw error;
  }
}
