import {
  createDirectSession,
  type DirectSession,
  type DirectSessionActivation,
} from "@hraness/direct/testing";

import {
  slopcameraDirect,
  type SlopcameraDirectRoute,
} from "./scenarios";
import {
  createSlopcameraDirectTransport,
  type SlopcameraDirectTransportHarness,
} from "./transport";
import type { SlopcameraDirectWorld } from "./world";

export type SlopcameraDirectSession = DirectSession<
  SlopcameraDirectWorld,
  SlopcameraDirectRoute,
  SlopcameraDirectTransportHarness
>;

/** Open the definition-owned deterministic session used by the recorder workbench. */
export function createSlopcameraDirectSession(activation: DirectSessionActivation) {
  return createDirectSession({
    definition: slopcameraDirect,
    activation,
    create: (context): SlopcameraDirectTransportHarness => {
      const harness = createSlopcameraDirectTransport(context.world, {
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
