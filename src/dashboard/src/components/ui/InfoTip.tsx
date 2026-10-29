import { ReactNode, useId, useRef, useState, KeyboardEvent } from 'react';
import { Info } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Longer explanation behind an (i) button (#360).
 *
 * WHY A DISCLOSURE AND NOT A TOOLTIP. `Tooltip` is for a hint — "this is a
 * hint, not documentation". What goes behind this is documentation: whole
 * sentences, caveats, sometimes a `<code>` span. A hover/focus popover is the
 * wrong shape for that. It vanishes the moment the pointer or focus moves, it
 * has no hover on touch, it cannot be selected or copied, and screen readers
 * get it as a transient description rather than content they can read at their
 * own pace.
 *
 * So the panel is plain content that opens in the flow and stays until it is
 * closed. No positioning, no portal, no dependency: the button carries
 * `aria-expanded` and `aria-controls` and the browser's own button semantics
 * supply Enter/Space.
 *
 * It is a hook rather than a component because the two halves live in
 * different places: render `button` beside the heading (NOT inside the `<h3>`,
 * or the panel becomes heading content) and `panel` AFTER the one-line summary,
 * so an open tip reads in order. Both share one open state. The panel is always
 * rendered and toggled with `hidden`, so `aria-controls` never points at
 * nothing — a dangling ARIA reference is worse than an absent one (Tabs.tsx).
 * Each tip must read correctly on its own, since it is read apart from the
 * summary it follows.
 *
 * Escape closes it from the button, or from a focusable element inside the
 * panel, and returns focus to the button. NOT yet verified inside a Radix
 * Dialog: a document-level Escape listener there may close the dialog too.
 */
export function useInfoTip(
  topic: string,
  content: ReactNode
): { button: ReactNode; panel: ReactNode } {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return;
    e.stopPropagation();
    setOpen(false);
    buttonRef.current?.focus();
  };

  const button = (
    <button
      ref={buttonRef}
      type="button"
      aria-label={`More about ${topic}`}
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => setOpen(o => !o)}
      onKeyDown={onKeyDown}
      className={cn(
        'dui-focus-ring inline-flex h-6 w-6 items-center justify-center rounded-full text-muted hover:text-fg focus-visible:outline-none',
        open && 'text-accent'
      )}
    >
      <Info className="h-4 w-4" aria-hidden="true" />
    </button>
  );

  const panel = (
    <div
      id={panelId}
      hidden={!open}
      onKeyDown={onKeyDown}
      className="mt-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm font-normal text-muted"
    >
      {content}
    </div>
  );

  return { button, panel };
}
