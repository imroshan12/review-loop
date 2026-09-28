import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { ICON_PATHS, type IconName } from "./icons.generated";

/** A Phosphor icon, inlined so it takes the surrounding text colour. Decorative unless given a label. */
export const Icon: FC<{ name: IconName; size?: number; class?: string; label?: string }> = ({ name, size = 20, class: className, label }) => (
  <svg
    class={`icon${className ? ` ${className}` : ""}`}
    viewBox="0 0 256 256"
    width={size}
    height={size}
    fill="currentColor"
    role={label ? "img" : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : "true"}
  >
    {raw(ICON_PATHS[name])}
  </svg>
);
