import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./index.css";
import { detectRuntimeBridge } from "./runtime-bridge";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("Atet root element is missing.");

document.documentElement.setAttribute("data-atet-surface", "product");
document.body.setAttribute("data-atet-surface", "product");

createRoot(root).render(
  <StrictMode>
    <App bridge={detectRuntimeBridge()} />
  </StrictMode>,
);
