import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { QuickCapture } from "./QuickCapture";
import "./style.css";

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>{window.location.hash === "#capture" ? <QuickCapture /> : <App />}</StrictMode>,
  );
