import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { initPwa } from "./pwa.ts";
import "./styles.css";

// Before React, and never awaited: registering the worker and asking for
// persistent storage are what keep the data alive (see pwa.ts), and neither has
// anything to say to the first render.
initPwa();

const container = document.getElementById("root");
if (!container) throw new Error("#root not found in index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
