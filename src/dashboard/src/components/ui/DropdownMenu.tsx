import { forwardRef, ComponentPropsWithoutRef, ElementRef } from 'react';
import * as RadixMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '../../lib/cn';
import { usePortalScope } from './PortalScope';

/**
 * Dropdown menu primitive (DROP-156 PR 3b).
 *
 * Deliberately NOT built in PR 2b, which is when the plan first called for it:
 * it had no consumer until now, and shipping an unused primitive costs bundle
 * weight and review attention for nothing. This lands with its first real
 * caller — the per-row action menu on the apps list.
 *
 * `DropdownMenuContent` binds the portal container itself, exactly like
 * `DialogContent`. Every Radix primitive portals to `document.body` by default,
 * which is OUTSIDE the `.drop-ui` token scope — where every `var(--token)`
 * resolves to nothing and the menu renders unstyled, with no error. See
 * ui/PortalScope.tsx.
 *
 * What Radix supplies that a hand-rolled menu would not: roving focus through
 * the items, type-ahead, Escape and outside-click dismissal, focus return to
 * the trigger, `aria-expanded`/`aria-haspopup` on the trigger, and collision
 *-aware placement. `aria-expanded` was one of the counts that was ZERO across
 * this dashboard.
 */
export const DropdownMenu = RadixMenu.Root;
export const DropdownMenuTrigger = RadixMenu.Trigger;

export const DropdownMenuContent = forwardRef<
  ElementRef<typeof RadixMenu.Content>,
  ComponentPropsWithoutRef<typeof RadixMenu.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, align = 'end', ...props }, ref) {
  const container = usePortalScope();
  return (
    <RadixMenu.Portal container={container ?? undefined}>
      <RadixMenu.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'dui-menu z-[90] min-w-[11rem] overflow-hidden rounded-lg p-1',
          className
        )}
        {...props}
      />
    </RadixMenu.Portal>
  );
});

export interface DropdownMenuItemProps
  extends ComponentPropsWithoutRef<typeof RadixMenu.Item> {
  tone?: 'default' | 'danger';
}

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof RadixMenu.Item>,
  DropdownMenuItemProps
>(function DropdownMenuItem({ className, tone = 'default', ...props }, ref) {
  return (
    <RadixMenu.Item
      ref={ref}
      className={cn(
        'dui-menu-item flex cursor-pointer select-none items-center gap-2 rounded px-2.5 py-2 text-sm outline-none',
        tone === 'danger' && 'dui-menu-item-danger',
        className
      )}
      {...props}
    />
  );
});

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <RadixMenu.Separator className={cn('my-1 h-px bg-line', className)} />;
}
