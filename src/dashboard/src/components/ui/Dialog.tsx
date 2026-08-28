import { forwardRef, ComponentPropsWithoutRef, ElementRef } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { usePortalScope } from './PortalScope';

/**
 * Modal dialog primitive on Radix (DROP-156).
 *
 * WHY RADIX AND NOT THE HAND-ROLLED VERSION. The dialog this replaces had no
 * focus trap, no Escape-to-dismiss and no focus restore — Tab walked straight
 * out of the open modal into the page behind it, and dismissing returned focus
 * to `<body>` rather than whatever opened it. Radix supplies all three, plus
 * `aria-modal`, `aria-labelledby`/`aria-describedby` wiring from Title and
 * Description, and inert-ing of the background. That is the whole reason for
 * the dependency; it is not a styling change.
 *
 * `DialogContent` binds the portal container itself rather than exposing it,
 * so no caller can forget it and silently render an unstyled dialog outside
 * the `.drop-ui` token scope — see PortalScope.tsx for why that is the default
 * failure mode here.
 *
 * Radix warns at runtime if a Content has no Title. Every dialog gets one;
 * `DialogTitle` is exported for that and `VisuallyHiddenTitle` covers the rare
 * case where the design has no visible heading.
 */
export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export const DialogTitle = forwardRef<
  ElementRef<typeof RadixDialog.Title>,
  ComponentPropsWithoutRef<typeof RadixDialog.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <RadixDialog.Title
      ref={ref}
      className={cn('text-base font-semibold text-fg', className)}
      {...props}
    />
  );
});

export const DialogDescription = forwardRef<
  ElementRef<typeof RadixDialog.Description>,
  ComponentPropsWithoutRef<typeof RadixDialog.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <RadixDialog.Description
      ref={ref}
      className={cn('text-sm leading-relaxed text-muted', className)}
      {...props}
    />
  );
});

export interface DialogContentProps
  extends ComponentPropsWithoutRef<typeof RadixDialog.Content> {
  /** Render the default top-right close button. */
  showClose?: boolean;
  /** Max-width utility for the panel; defaults to the confirm-dialog width. */
  widthClassName?: string;
}

export const DialogContent = forwardRef<
  ElementRef<typeof RadixDialog.Content>,
  DialogContentProps
>(function DialogContent(
  { className, children, showClose = true, widthClassName = 'max-w-sm', ...props },
  ref
) {
  const container = usePortalScope();

  return (
    // `container ?? undefined` — Radix reads undefined as "document.body". The
    // scope node is null only for the single render before its callback ref
    // lands, which is never a render a dialog is open in.
    <RadixDialog.Portal container={container ?? undefined}>
      {/* Tailwind's own `black`, not a token — opacity modifiers work on stock
          palette colors and produce NOTHING on ours (they are hex, so
          <alpha-value> cannot substitute). See tailwind-preset.js. */}
      <RadixDialog.Overlay className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm data-[state=open]:animate-in" />
      <RadixDialog.Content
        ref={ref}
        className={cn(
          'dui-dialog fixed left-1/2 top-1/2 z-[101] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl p-6',
          widthClassName,
          className
        )}
        {...props}
      >
        {children}
        {showClose && (
          <RadixDialog.Close
            aria-label="Close dialog"
            className="dui-focus-ring absolute right-4 top-4 rounded text-faint transition-colors hover:text-fg focus-visible:outline-none"
          >
            <X className="h-4 w-4" />
          </RadixDialog.Close>
        )}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
});
