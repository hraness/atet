import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import "./index.css";
import { detectRuntimeBridge } from "./runtime-bridge";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("Transmute root element is missing.");

document.documentElement.setAttribute("data-transmute-surface", "product");
document.body.setAttribute("data-transmute-surface", "product");

createRoot(root).render(
  <StrictMode>
    <App bridge={detectRuntimeBridge()} />
  </StrictMode>,
);
