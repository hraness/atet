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
  PORTABLE_TRANSMUTE_OPERATION_CONTRACTS,
  type TransmuteDiagramCheckInput,
  type TransmuteDiagramCheckOutput,
  type TransmuteDiagramRenderInput,
  type TransmuteDiagramRenderOutput,
  type TransmuteImageGenerateInput,
  type TransmuteImageGenerateOutput,
  type TransmuteImageVectorizeInput,
  type TransmuteImageVectorizeOutput,
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
      input: OperationInputValue<TransmuteDiagramCheckInput>,
      options?: OperationNodeOptions,
    ) => Ref<TransmuteDiagramCheckOutput>
    render: (
      key: string,
      input: OperationInputValue<TransmuteDiagramRenderInput>,
      options?: OperationNodeOptions,
    ) => Ref<TransmuteDiagramRenderOutput>
  }>

  readonly image: Readonly<{
    generate: (
      key: string,
      input: OperationInputValue<TransmuteImageGenerateInput>,
      options?: OperationNodeOptions,
    ) => Ref<TransmuteImageGenerateOutput>
    vectorize: (
      key: string,
      input: OperationInputValue<TransmuteImageVectorizeInput>,
      options?: OperationNodeOptions,
    ) => Ref<TransmuteImageVectorizeOutput>
  }>

  private constructor(builder: WorkflowGraphBuilder) {
    this.#builder = builder
    this.diagram = Object.freeze({
      check: (
        key: string,
        input: OperationInputValue<TransmuteDiagramCheckInput>,
        options: OperationNodeOptions = {},
      ) => this.#builder.operation(
        key,
        PORTABLE_TRANSMUTE_OPERATION_CONTRACTS["transmute.diagram.check"],
        input,
        options,
      ),
      render: (
        key: string,
        input: OperationInputValue<TransmuteDiagramRenderInput>,
        options: OperationNodeOptions = {},
      ) => this.#builder.operation(
        key,
        PORTABLE_TRANSMUTE_OPERATION_CONTRACTS["transmute.diagram.render"],
        input,
        options,
      ),
    })
    this.image = Object.freeze({
      generate: (
        key: string,
        input: OperationInputValue<TransmuteImageGenerateInput>,
        options: OperationNodeOptions = {},
      ) => this.#builder.operation(
        key,
        PORTABLE_TRANSMUTE_OPERATION_CONTRACTS["transmute.image.generate"],
        input,
        options,
      ),
      vectorize: (
        key: string,
        input: OperationInputValue<TransmuteImageVectorizeInput>,
        options: OperationNodeOptions = {},
      ) => this.#builder.operation(
        key,
        PORTABLE_TRANSMUTE_OPERATION_CONTRACTS["transmute.image.vectorize"],
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
