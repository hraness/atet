import { ProjectRenderInputSchemaV4 } from "../application/operations/render/project";
import { defineWorkflow } from "../code/public";

/** Prepared immutable scene footage enters the ordinary compositor before cuts/speed. */
export const directedScene = defineWorkflow({
  id: "directed-scene", version: 1,
  inputSchema: ProjectRenderInputSchemaV4,
  inputSchemaId: "slopcamera.workflow.directed-scene.input/v1",
  build(workflow, input) {
    return { render: workflow.render.spatialProject("render", input) };
  },
});
