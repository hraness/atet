import {
  type AuthoredWorkflowGraphV1,
  type OperationInputValue,
  type Ref,
  type WorkflowIdentity,
  type WorkflowOutputValue,
} from "./contracts.js"
import {
  WorkflowGraphBuilder,
  type OperationNodeOptions,
} from "./graph-builder.js"
import {
  PORTABLE_SLOPCAMERA_OPERATION_CONTRACTS,
  type SlopcameraDiagramCheckInput,
  type SlopcameraDiagramCheckOutput,
  type SlopcameraDiagramRenderInput,
  type SlopcameraDiagramRenderOutput,
  type SlopcameraImageGenerateInput,
  type SlopcameraImageGenerateOutput,
  type SlopcameraImageVectorizeInput,
  type SlopcameraImageVectorizeOutput,
} from "./public-operations.js"
import { PUBLIC_WORKFLOW_REGISTRY_PROJECTION } from "./projection.js"

export interface PortableWorkflowFragment<Input, Output> {
  build(builder: PortableWorkflowBuilder, input: Input): Output
}

export function definePortableWorkflowFragment<Input, Output>(
  build: (builder: PortableWorkflowBuilder, input: Input) => Output,
): PortableWorkflowFragment<Input, Output> {
  return Object.freeze({ build })
}

export class PortableWorkflowBuilder {
  readonly #builder: WorkflowGraphBuilder

  readonly diagram: Readonly<{
    check: (
      key: string,
      input: OperationInputValue<SlopcameraDiagramCheckInput>,
      options?: OperationNodeOptions,
    ) => Ref<SlopcameraDiagramCheckOutput>
    render: (
      key: string,
      input: OperationInputValue<SlopcameraDiagramRenderInput>,
      options?: OperationNodeOptions,
    ) => Ref<SlopcameraDiagramRenderOutput>
  }>

  readonly image: Readonly<{
    generate: (
      key: string,
      input: OperationInputValue<SlopcameraImageGenerateInput>,
      options?: OperationNodeOptions,
    ) => Ref<SlopcameraImageGenerateOutput>
    vectorize: (
      key: string,
      input: OperationInputValue<SlopcameraImageVectorizeInput>,
      options?: OperationNodeOptions,
    ) => Ref<SlopcameraImageVectorizeOutput>
  }>

  private constructor(builder: WorkflowGraphBuilder) {
    this.#builder = builder
    this.diagram = Object.freeze({
      check: (
        key: string,
        input: OperationInputValue<SlopcameraDiagramCheckInput>,
        options: OperationNodeOptions = {},
      ) => this.#builder.operation(
        key,
        PORTABLE_SLOPCAMERA_OPERATION_CONTRACTS["slopcamera.diagram.check"],
        input,
        options,
      ),
      render: (
        key: string,
        input: OperationInputValue<SlopcameraDiagramRenderInput>,
        options: OperationNodeOptions = {},
      ) => this.#builder.operation(
        key,
        PORTABLE_SLOPCAMERA_OPERATION_CONTRACTS["slopcamera.diagram.render"],
        input,
        options,
      ),
    })
    this.image = Object.freeze({
      generate: (
        key: string,
        input: OperationInputValue<SlopcameraImageGenerateInput>,
        options: OperationNodeOptions = {},
      ) => this.#builder.operation(
        key,
        PORTABLE_SLOPCAMERA_OPERATION_CONTRACTS["slopcamera.image.generate"],
        input,
        options,
      ),
      vectorize: (
        key: string,
        input: OperationInputValue<SlopcameraImageVectorizeInput>,
        options: OperationNodeOptions = {},
      ) => this.#builder.operation(
        key,
        PORTABLE_SLOPCAMERA_OPERATION_CONTRACTS["slopcamera.image.vectorize"],
        input,
        options,
      ),
    })
  }

  static create(): PortableWorkflowBuilder {
    return new PortableWorkflowBuilder(
      WorkflowGraphBuilder.create(PUBLIC_WORKFLOW_REGISTRY_PROJECTION),
    )
  }

  namespace(segment: string): PortableWorkflowBuilder {
    return new PortableWorkflowBuilder(this.#builder.namespace(segment))
  }

  fragment<Input, Output>(
    namespace: string,
    fragment: PortableWorkflowFragment<Input, Output>,
    input: Input,
  ): Output {
    return fragment.build(this.namespace(namespace), input)
  }

  build(
    workflow: WorkflowIdentity,
    outputs: WorkflowOutputValue,
  ): AuthoredWorkflowGraphV1 {
    return this.#builder.build(workflow, outputs)
  }
}
