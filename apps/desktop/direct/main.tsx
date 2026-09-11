import { createRoot } from "react-dom/client";

import "@hraness/design-kit/fonts.css";
import "../frontend/vendor/paper-theme/paper-theme.css";
import "../frontend/src/index.css";
import "./workbench.css";

import { mountSlopcameraDirect } from "./mount";
import {
  SlopcameraDirectError,
  SlopcameraDirectWorkbench,
} from "./workbench";

const rootElement = document.querySelector("#root");
if (rootElement === null) throw new Error("The Slopcamera Direct root element is missing.");
const root = createRoot(rootElement);
const mounted = mountSlopcameraDirect(
  { kind: "query", source: globalThis.location.search },
  {
    registerPagehide: (listener) => {
      globalThis.addEventListener("pagehide", listener, { once: true });
      return (): undefined => {
        globalThis.removeEventListener("pagehide", listener);
        return undefined;
      };
    },
    target: window,
  },
);

if (!mounted.ok) {
  root.render(<SlopcameraDirectError message={mounted.error.message} />);
} else {
  try {
    root.render(<SlopcameraDirectWorkbench mounted={mounted.value} />);
  } catch (reason) {
    mounted.value.dispose();
    throw reason;
  }
}
