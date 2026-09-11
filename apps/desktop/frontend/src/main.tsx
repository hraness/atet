import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "@hraness/design-kit/fonts.css";
import "../vendor/paper-theme/paper-theme.css";
import "./index.css";
import { detectRuntimeBridge } from "./runtime-bridge";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("Slopcamera root element is missing.");

document.documentElement.setAttribute("data-slopcamera-surface", "product");
document.body.setAttribute("data-slopcamera-surface", "product");

createRoot(root).render(
  <StrictMode>
    <App bridge={detectRuntimeBridge()} />
  </StrictMode>,
);
