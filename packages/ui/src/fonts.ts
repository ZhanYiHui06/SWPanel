/* Side-effect imports of locally bundled fonts.
   Font families are exposed through CSS variables `--font-sans` / `--font-mono`
   declared in `tokens.css`. App entry should import this module once:

     import "@swpanel/ui/fonts";

   Requires: @fontsource/inter, @fontsource/jetbrains-mono (declared deps).
   Production must never load Google Fonts (architecture §4.4). */

import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";

/** Names registered by @fontsource. Useful for canvas / custom contexts. */
export const fonts = Object.freeze({
  sans: "Inter",
  mono: "JetBrains Mono"
} as const);
