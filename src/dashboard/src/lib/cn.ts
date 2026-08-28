import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, with later Tailwind utilities winning over earlier ones
 * (DROP-156). `clsx` handles the conditional/array/object forms; `twMerge`
 * resolves genuine conflicts so a caller's `className` can override a
 * primitive's defaults instead of depending on stylesheet order.
 *
 * Without this, `<Button className="px-3">` leaves BOTH `px-4` (the variant's)
 * and `px-3` in the class list and the winner is whichever CSS rule Tailwind
 * emitted last — not what the caller wrote.
 *
 * VERIFIED against the token utilities from tailwind-preset.js rather than
 * assumed, because twMerge only knows Tailwind's stock scales and our color
 * names are custom:
 *
 *   'text-muted text-sm'   -> both kept      (color vs font-size, not a conflict)
 *   'text-muted' + 'text-fg' -> 'text-fg'    (both colors, later wins)
 *   'px-4 py-2.5' + 'px-3' -> 'py-2.5 px-3'
 *
 * twMerge classifies any `text-*` value that is not a known font-size as a
 * color, which is exactly right for `muted`/`faint`/`fg`/`accent`. So no
 * `extendTailwindMerge` config is needed. If a future token is ever named like
 * a stock scale value, that assumption breaks and this needs a custom config.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
