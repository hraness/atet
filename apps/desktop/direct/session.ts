import {
  createDirectSession,
  type DirectSession,
  type DirectSessionActivation,
} from "@hraness/direct/testing";

import {
  atetDirect,
  type AtetDirectRoute,
} from "./scenarios";
import {
  createAtetDirectTransport,
  type AtetDirectTransportHarness,
} from "./transport";
import type { AtetDirectWorld } from "./world";

export type AtetDirectSession = DirectSession<
  AtetDirectWorld,
  AtetDirectRoute,
  AtetDirectTransportHarness
>;

/** Open the definition-owned deterministic session used by the recorder workbench. */
export function createAtetDirectSession(activation: DirectSessionActivation) {
  return createDirectSession({
    definition: atetDirect,
    activation,
    create: (context): AtetDirectTransportHarness => {
      const harness = createAtetDirectTransport(context.world, {
        activity: context.activity,
        signal: context.signal,
      });
      context.onDispose((): undefined => {
        harness.dispose();
        return undefined;
      });
      return harness;
    },
    observe: (harness) => ({
      violations: [
        {
          name: "activityErrors",
          read: () => harness.getSnapshot().activityErrors,
        },
        {
          name: "blockedNetworkRequests",
          read: () => harness.getSnapshot().blockedNetworkRequests,
        },
        {
          name: "protocolErrors",
          read: () => harness.getSnapshot().protocolErrors,
        },
      ],
      readRemainingWork: () => {
        const snapshot = harness.getSnapshot();
        return {
          disposed: snapshot.disposed,
          eventListeners: snapshot.eventListeners,
          transitions: snapshot.remainingTransitions,
        };
      },
    }),
  });
}
