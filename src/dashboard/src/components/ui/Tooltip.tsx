import { ReactNode } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { cn } from '../../lib/cn';
import { usePortalScope } from './PortalScope';

export interface TooltipProps {
  /** The hint. Keep it short — this is a hint, not documentation. */
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}

/**
 * Hint on hover AND on keyboard focus (DROP-156 PR 4).
 *
 * WHAT THIS REPLACES, AND WHAT IT DOES NOT. The dashboard used the native
 * `title` attribute in 29 places. `title` shows on mouse hover only: it is
 * unreachable by keyboard, invisible on touch, slow, and styled by the OS.
 *
 * It is worth being precise about the gain, because it is narrower than the
 * count suggests. Most of those controls ALREADY have an accessible name (an
 * `aria-label`, or visible text), so `title` was not carrying their identity —
 * it was carrying an extra hint. So this is adopted only where the hint says
 * something the name does NOT, and plain `title` is left alone elsewhere
 * rather than churning 29 call sites for a wrapper.
 *
 * Radix supplies the positioning (collision-aware, which is the genuinely hard
 * part), the focus/blur and hover/leave handling, Escape dismissal, and
 * `aria-describedby` wiring from the content back to the trigger.
 *
 * Like every other portalling primitive here it binds the portal container
 * itself — see ui/PortalScope.tsx for why `document.body` is the wrong place.
 *
 * `Provider` is per-instance rather than app-wide on purpose: the delay is a
 * property of this hint, and a global provider would be one more thing to reach
 * for and mis-configure from a leaf component.
 */
export function Tooltip({ content, children, side = 'top', className }: TooltipProps) {
  const container = usePortalScope();
  return (
    <RadixTooltip.Provider delayDuration={300}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal container={container ?? undefined}>
          <RadixTooltip.Content
            side={side}
            sideOffset={6}
            className={cn(
              'dui-tooltip z-[95] max-w-xs rounded-md px-2.5 py-1.5 text-xs',
              className
            )}
          >
            {content}
            <RadixTooltip.Arrow className="dui-tooltip-arrow" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}

export default Tooltip;
