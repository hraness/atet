import { createRoot } from "react-dom/client";

import "../frontend/src/index.css";
import "./workbench.css";

import { mountTransmuteDirect } from "./mount";
import {
  TransmuteDirectError,
  TransmuteDirectWorkbench,
} from "./workbench";

const rootElement = document.querySelector("#root");
if (rootElement === null) throw new Error("The Transmute Direct root element is missing.");
const root = createRoot(rootElement);
const mounted = mountTransmuteDirect(
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
  root.render(<TransmuteDirectError message={mounted.error.message} />);
} else {
  try {
    root.render(<TransmuteDirectWorkbench mounted={mounted.value} />);
  } catch (reason) {
    mounted.value.dispose();
    throw reason;
  }
}
