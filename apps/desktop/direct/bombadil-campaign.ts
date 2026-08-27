import {
  always,
  eventually,
  extract,
  type JSON as BombadilJson,
} from "@antithesishq/bombadil";
import type { State as BombadilBrowserState } from "@antithesishq/bombadil/browser";
import {
  createDirectBombadilActions,
  createDirectBombadilProperties,
} from "@hraness/direct/tooling/bombadil-campaign";

export * from "@antithesishq/bombadil/browser/defaults/properties";

interface AtetBombadilObservation {
  readonly [key: string | number | symbol]: BombadilJson;
  readonly controlsPresent: boolean;
  readonly heading: string;
  readonly scenario: string;
}

const atet = extract<BombadilBrowserState, AtetBombadilObservation>((state) => ({
  controlsPresent: state.document.querySelector(
    'main.recorder-shell [aria-label="Recording controls"]',
  ) !== null,
  heading: state.document.querySelector("main.recorder-shell h1")?.textContent?.trim() ?? "",
  scenario: state.document.querySelector("[data-direct-scenario]")
    ?.getAttribute("data-direct-scenario") ?? "",
}));
const direct = createDirectBombadilProperties();

export const atet_safe_actions = createDirectBombadilActions();
export const atet_recorder_surface_persists = always(
  eventually(() =>
    atet.current.scenario === "idle-ready"
    && atet.current.heading === "Raw capture"
    && atet.current.controlsPresent
  ).within(10, "seconds"),
);
export const direct_exact_contract = direct.exactContract;
export const direct_stable_catalog = direct.stableCatalog;
export const direct_no_declared_violations = direct.noDeclaredViolations;
export const direct_eventual_quiescence = direct.eventualQuiescence;
