/**
 * Compatibility façade for the local Transmute host.
 *
 * The portable graph, reference, policy, and authoring contracts are owned by
 * the public SDK. Only the durable local-host plan envelope remains here.
 */
export * from "@hraness/transmute/code/advanced";
export * from "./plan-contracts";
export {
  OperationDiscoverySchema,
  OperationKindSchema,
  type GraphOperationDiscovery,
} from "./plan-contracts";
