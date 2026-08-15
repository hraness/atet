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
  PORTABLE_ATET_OPERATION_CONTRACTS,
  type AtetDiagramCheckInput,
  type AtetDiagramCheckOutput,
  type AtetDiagramRenderInput,
  type AtetDiagramRenderOutput,
  type AtetImageGenerateInput,
  type AtetImageGenerateOutput,
  type AtetImageVectorizeInput,
  type AtetImageVectorizeOutput,
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
      input: OperationInputValue<AtetDiagramCheckInput>,
      options?: OperationNodeOptions,
    ) => Ref<AtetDiagramCheckOutput>
    render: (
      key: string,
      input: OperationInputValue<AtetDiagramRenderInput>,
      options?: OperationNodeOptions,
    ) => Ref<AtetDiagramRenderOutput>
  }>

  readonly image: Readonly<{
    generate: (
      key: string,
      input: OperationInputValue<AtetImageGenerateInput>,
      options?: OperationNodeOptions,
    ) => Ref<AtetImageGenerateOutput>
    vectorize: (
      key: string,
      input: OperationInputValue<AtetImageVectorizeInput>,
      options?: OperationNodeOptions,
    ) => Ref<AtetImageVectorizeOutput>
  }>

  private constructor(builder: WorkflowGraphBuilder) {
    this.#builder = builder
    this.diagram = Object.freeze({
      check: (
        key: string,
        input: OperationInputValue<AtetDiagramCheckInput>,
        options: OperationNodeOptions = {},
      ) => this.#builder.operation(
        key,
        PORTABLE_ATET_OPERATION_CONTRACTS["atet.diagram.check"],
        input,
        options,
      ),
      render: (
        key: string,
        input: OperationInputValue<AtetDiagramRenderInput>,
        options: OperationNodeOptions = {},
      ) => this.#builder.operation(
        key,
        PORTABLE_ATET_OPERATION_CONTRACTS["atet.diagram.render"],
        input,
        options,
      ),
    })
    this.image = Object.freeze({
      generate: (
        key: string,
        input: OperationInputValue<AtetImageGenerateInput>,
        options: OperationNodeOptions = {},
      ) => this.#builder.operation(
        key,
        PORTABLE_ATET_OPERATION_CONTRACTS["atet.image.generate"],
        input,
        options,
      ),
      vectorize: (
        key: string,
        input: OperationInputValue<AtetImageVectorizeInput>,
        options: OperationNodeOptions = {},
      ) => this.#builder.operation(
        key,
        PORTABLE_ATET_OPERATION_CONTRACTS["atet.image.vectorize"],
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
