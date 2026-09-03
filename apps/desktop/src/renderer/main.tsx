import "@swpanel/ui/fonts";
import "@swpanel/ui/styles";
import "./styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";

import { createAppRouter } from "./app/routes.js";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("SWPanel renderer root element is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={createAppRouter()} />
  </StrictMode>
);
