import { createRoot } from "react-dom/client";

import "@hraness/design-kit/fonts.css";
import "../frontend/src/index.css";
import "./workbench.css";

import { mountAtetDirect } from "./mount";
import {
  AtetDirectError,
  AtetDirectWorkbench,
} from "./workbench";

const rootElement = document.querySelector("#root");
if (rootElement === null) throw new Error("The Atet Direct root element is missing.");
const root = createRoot(rootElement);
const mounted = mountAtetDirect(
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
  root.render(<AtetDirectError message={mounted.error.message} />);
} else {
  try {
    root.render(<AtetDirectWorkbench mounted={mounted.value} />);
  } catch (reason) {
    mounted.value.dispose();
    throw reason;
  }
}
