import type { SVGProps } from "react";

/**
 * Common icon props. All SWPanel icons render a 16x16 viewBox with
 * `fill="none"` and `stroke="currentColor"` at 1.3 px (the prototype's
 * effective thin-stroke style). Size defaults to 16px.
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "width" | "height"> {
  size?: number;
}

/** Baseline SVG attributes shared by every SWPanel icon. */
export const iconBaseProps = Object.freeze({
  viewBox: "0 0 16 16",
  fill: "none",
  xmlns: "http://www.w3.org/2000/svg"
} as const);

/** Stroke style matching the confirmed prototype. */
export const iconStrokeProps = Object.freeze({
  stroke: "currentColor",
  strokeWidth: 1.3,
  strokeLinecap: "round",
  strokeLinejoin: "round"
} as const);

/**
 * Creates a typed 16px thin-stroke icon component from raw path/child
 * descriptors. The base props can be overridden per icon (e.g. a filled
 * play glyph), matching how the prototype mixes strokes and fills.
 */
export function createIcon(children: React.ReactNode): (props: IconProps) => React.ReactElement {
  return function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg width={size} height={size} {...iconBaseProps} aria-hidden="true" {...rest}>
        {children}
      </svg>
    );
  };
}
