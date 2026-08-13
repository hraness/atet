import {
  createDirectSession,
  type DirectSession,
  type DirectSessionActivation,
} from "@hraness/direct/testing";

import {
  transmuteDirect,
  type TransmuteDirectRoute,
} from "./scenarios";
import {
  createTransmuteDirectTransport,
  type TransmuteDirectTransportHarness,
} from "./transport";
import type { TransmuteDirectWorld } from "./world";

export type TransmuteDirectSession = DirectSession<
  TransmuteDirectWorld,
  TransmuteDirectRoute,
  TransmuteDirectTransportHarness
>;

/** Open the definition-owned deterministic session used by the recorder workbench. */
export function createTransmuteDirectSession(activation: DirectSessionActivation) {
  return createDirectSession({
    definition: transmuteDirect,
    activation,
    create: (context): TransmuteDirectTransportHarness => {
      const harness = createTransmuteDirectTransport(context.world, {
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
