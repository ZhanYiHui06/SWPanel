import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/** Renders an element to static markup for assertions (no DOM required). */
export function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}
