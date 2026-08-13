import { randomUUID } from "node:crypto";

import {
  commitProjectEditsOperationDefinition,
  commitProjectEditsOperationDefinitionV2,
  commitProjectEditsOperationDefinitionV3,
  bindCandidateRevisionOperationDefinition,
  createCandidateRevisionOperationDefinition,
  createCreativeCandidateOperationDefinition,
  createVariantMatrixOperationDefinition,
  materializeVariantSelectionOperationDefinition,
  promoteVariantSelectionOperationDefinition,
  bindCandidateRenderOutputOperationDefinition,
  selectVariantOperationDefinition,
  createFacesOperationDefinition,
  createMusicOperationDefinition,
  createProjectEditRevisionOperationDefinition,
  createProjectInactivityOperationDefinition,
  sceneAnalysisOperationDefinition,
  deriveEditBatchOperationDefinition,
  deriveEditBatchOperationDefinitionV2,
  deriveEditBatchOperationDefinitionV3,
  followFacesOperationDefinition,
  freezeProjectEditRevisionOperationDefinition,
  gatewayImageOperationDefinition,
  gatewaySpeechOperationDefinition,
  gatewayTranscriptionOperationDefinition,
  gatewayVideoOperationDefinition,
  mediaAudioEffectsOperationDefinition,
  mediaColorGradeOperationDefinition,
  mediaIngestOperationDefinition,
  createHtmlOverlayOperationDefinition,
  mediaOverlayOperationDefinition,
  projectAutoZoomOperationDefinition,
  projectRenderPlanOperationDefinition,
  projectRenderPlanOperationDefinitionV2,
  projectRenderOperationDefinition,
  projectRenderOperationDefinitionV2,
  projectRenderOperationDefinitionV3,
  projectSnapshotOperationDefinition,
  recordingPauseOperationDefinition,
  recordingResumeOperationDefinition,
  recordingStartOperationDefinition,
  recordingStartOperationDefinitionV1,
  recordingStopOperationDefinition,
  transmuteDiagramCheckOperationDefinition,
  transmuteDiagramRenderOperationDefinition,
  transmuteImageVectorizeOperationDefinition,
} from "./operations";
import { transmutePortableOperationDefinitions } from "./operations/transmute-portable";
import { OperationRegistry } from "./registry";

export interface CreateApplicationOperationRegistryOptions {
  readonly nextAnalysisId?: () => string;
  readonly toolVersion?: string;
}

export function createApplicationOperationRegistry(
  options: CreateApplicationOperationRegistryOptions = {},
): OperationRegistry {
  const nextAnalysisId = options.nextAnalysisId
    ?? (() => `analysis_${randomUUID().replaceAll("-", "")}`);
  const toolVersion = options.toolVersion ?? "transmute-1.0.0";
  const registry = new OperationRegistry();
  registry.register(projectSnapshotOperationDefinition);
  registry.register(createProjectInactivityOperationDefinition({
    nextAnalysisId,
    toolVersion,
  }));
  registry.register(createFacesOperationDefinition({ nextAnalysisId }));
  registry.register(createMusicOperationDefinition({ nextAnalysisId, toolVersion }));
  registry.register(sceneAnalysisOperationDefinition);
  registry.register(projectAutoZoomOperationDefinition);
  registry.register(deriveEditBatchOperationDefinition);
  registry.register(deriveEditBatchOperationDefinitionV2);
  registry.register(deriveEditBatchOperationDefinitionV3);
  registry.register(followFacesOperationDefinition);
  registry.register(createCandidateRevisionOperationDefinition);
  registry.register(bindCandidateRevisionOperationDefinition);
  registry.register(freezeProjectEditRevisionOperationDefinition);
  registry.register(createCreativeCandidateOperationDefinition);
  registry.register(createVariantMatrixOperationDefinition);
  registry.register(selectVariantOperationDefinition);
  registry.register(mediaIngestOperationDefinition);
  registry.register(createHtmlOverlayOperationDefinition({ toolVersion }));
  registry.register(mediaOverlayOperationDefinition);
  registry.register(mediaAudioEffectsOperationDefinition);
  registry.register(mediaColorGradeOperationDefinition);
  registry.register(gatewayImageOperationDefinition);
  registry.register(gatewayVideoOperationDefinition);
  registry.register(gatewaySpeechOperationDefinition);
  registry.register(gatewayTranscriptionOperationDefinition);
  registry.register(createProjectEditRevisionOperationDefinition);
  registry.register(commitProjectEditsOperationDefinition);
  registry.register(commitProjectEditsOperationDefinitionV2);
  registry.register(commitProjectEditsOperationDefinitionV3);
  registry.register(promoteVariantSelectionOperationDefinition);
  registry.register(bindCandidateRenderOutputOperationDefinition);
  registry.register(projectRenderPlanOperationDefinition);
  registry.register(projectRenderPlanOperationDefinitionV2);
  registry.register(projectRenderOperationDefinition);
  registry.register(projectRenderOperationDefinitionV2);
  registry.register(projectRenderOperationDefinitionV3);
  registry.register(materializeVariantSelectionOperationDefinition);
  registry.register(recordingStartOperationDefinitionV1);
  registry.register(recordingStartOperationDefinition);
  registry.register(recordingPauseOperationDefinition);
  registry.register(recordingResumeOperationDefinition);
  registry.register(recordingStopOperationDefinition);
  registry.register(transmuteDiagramCheckOperationDefinition);
  registry.register(transmuteDiagramRenderOperationDefinition);
  registry.register(transmuteImageVectorizeOperationDefinition);
  for (const definition of transmutePortableOperationDefinitions) {
    registry.register(definition);
  }
  return registry;
}
