import { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import Button from './ui/Button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/Dialog';

interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'default';
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue>({
  confirm: async () => false,
});

export function useConfirm() {
  return useContext(ConfirmContext).confirm;
}

/**
 * Promise-returning confirmation dialog, on the Radix `Dialog` primitive
 * (DROP-156).
 *
 * The public API is unchanged — `useConfirm()` still returns a function
 * resolving to a boolean, and no call site moves. What changes is everything
 * the hand-rolled version could not do: focus is trapped inside the open
 * dialog, Escape dismisses it, focus returns to whatever opened it, the
 * background is inert to assistive tech, and Title/Description are wired to
 * `aria-labelledby`/`aria-describedby` rather than a hand-written `aria-label`.
 *
 * The `.drop-ui` scoping that PR 1 added by hand here now comes from
 * `DialogContent`, which binds the portal container itself (see
 * ui/PortalScope.tsx) — so it cannot be forgotten by this or any future caller.
 *
 * One behavioural subtlety worth stating: a dismissal that does NOT go through
 * a button — Escape, or a click on the overlay — must still settle the promise,
 * or an `await confirm(...)` hangs forever and the caller silently stalls.
 * `onOpenChange` is the single funnel for that, so every close path resolves.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; options: ConfirmOptions }>({
    open: false,
    options: { title: '', message: '' },
  });

  // The resolver lives in a ref, not in state. Calling it from inside a
  // setState updater would fire a side effect during the render phase — which
  // React may run twice (StrictMode does, in development), resolving the
  // promise more than once.
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  /**
   * What to return focus to when the dialog closes.
   *
   * Radix restores focus to the dialog's `Trigger`. This dialog has none — it
   * is opened programmatically from `confirm()`, often several components away
   * from whatever the user actually clicked — so there is nothing for Radix to
   * restore to and focus lands on `<body>`. Measured, not assumed: with this
   * ref removed, a keyboard user who dismisses the dialog is dropped back at
   * the top of the document and has to Tab all the way to where they were.
   *
   * Only the caller knows the opener, so capture it at `confirm()` time.
   */
  const openerRef = useRef<HTMLElement | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
      resolverRef.current = resolve;
      setState({ open: true, options });
    });
  }, []);

  /**
   * `isConnected` matters: the opener is frequently a row-level button in a
   * list the confirmed action then deletes. Focusing a detached node silently
   * puts focus on `<body>` anyway, so fall through to Radix's own behaviour
   * rather than pretending.
   */
  const restoreFocus = useCallback((event: Event) => {
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) {
      event.preventDefault();
      opener.focus();
    }
  }, []);

  // Idempotent: clearing the ref first means a second close path (say Escape
  // landing right behind a button click) resolves nothing rather than settling
  // an already-settled promise.
  const settle = useCallback((result: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setState((s) => ({ ...s, open: false }));
    resolve?.(result);
  }, []);

  const isDanger = state.options.variant === 'danger';

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <Dialog
        open={state.open}
        // Fires for Escape and overlay clicks as well as the close button, so
        // no dismissal path can leave the promise unsettled.
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
      >
        <DialogContent onCloseAutoFocus={restoreFocus}>
          <div className="flex gap-4">
            <div
              className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${
                isDanger ? 'dui-dialog-icon-danger' : 'dui-dialog-icon-default'
              }`}
            >
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="mb-1">{state.options.title}</DialogTitle>
              <DialogDescription>{state.options.message}</DialogDescription>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <Button variant="secondary" onClick={() => settle(false)}>
              {state.options.cancelText || 'Cancel'}
            </Button>
            <Button variant={isDanger ? 'danger' : 'primary'} onClick={() => settle(true)}>
              {state.options.confirmText || 'Confirm'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}
