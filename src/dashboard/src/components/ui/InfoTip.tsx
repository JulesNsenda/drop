import { ReactNode, useId, useRef, useState, KeyboardEvent } from 'react';
import { Info } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface InfoTipProps {
  /** What the tip is about; becomes the button's name ("More about <topic>"). */
  topic: string;
  /** The explanation. May be several sentences — that is the point. */
  children: ReactNode;
  className?: string;
}

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
 * So the panel is plain content that opens in the flow, below the line the
 * button sits on, and stays until it is closed. No positioning, no portal, no
 * dependency: the button carries `aria-expanded` and `aria-controls` and the
 * browser's own button semantics supply Enter/Space.
 *
 * Place it inside a `flex flex-wrap` row next to the heading. It renders two
 * siblings — the button, then a full-width panel that wraps onto its own line —
 * so the caller owns the row.
 *
 * Escape closes it from the button or from inside the panel, and returns focus
 * to the button so a keyboard user is not dropped at the top of the page.
 */
export function InfoTip({ topic, children, className }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const button = useRef<HTMLButtonElement>(null);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !open) return;
    e.stopPropagation();
    setOpen(false);
    button.current?.focus();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`More about ${topic}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onKeyDown}
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded-full text-muted hover:text-fg',
          open && 'text-accent',
          className
        )}
      >
        <Info className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={panelId}
          onKeyDown={onKeyDown}
          className="w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm font-normal text-muted"
        >
          {children}
        </div>
      )}
    </>
  );
}

export default InfoTip;
