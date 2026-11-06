import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App, createAppRouter } from "./app";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App router={createAppRouter()} />
  </StrictMode>,
);
