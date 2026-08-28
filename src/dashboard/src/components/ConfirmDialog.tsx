import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import Button from './ui/Button';

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
 * Promise-returning confirmation dialog.
 *
 * SCOPE (DROP-156): `ConfirmProvider` wraps <Routes> in App.tsx, so this
 * renders ABOVE `AppShell`/`AuthLayout` — the only elements carrying
 * `.drop-ui`. Until this fix the dialog sat outside the token scope entirely,
 * which is why it was written against Tailwind's stock `gray-*`/`drop-*`
 * palette: the design system was unreachable from here. The root now
 * re-establishes the scope, with `dui-portal` cancelling the opaque
 * `background: var(--bg)` that bare `.drop-ui` sets (see app-ui.css) — without
 * it the wrapper would paint a full-screen fill over the app.
 *
 * Behaviour is unchanged from the previous version. Focus trapping, Escape-to-
 * dismiss and focus restore are still MISSING and are deliberately left for the
 * Radix rewrite rather than hand-rolled here.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{
    open: boolean;
    options: ConfirmOptions;
    resolve: ((value: boolean) => void) | null;
  }>({
    open: false,
    options: { title: '', message: '' },
    resolve: null,
  });

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setState({ open: true, options, resolve });
    });
  }, []);

  const handleClose = (result: boolean) => {
    state.resolve?.(result);
    setState((s) => ({ ...s, open: false, resolve: null }));
  };

  const isDanger = state.options.variant === 'danger';

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {state.open && (
        <div className="drop-ui dui-portal fixed inset-0 z-[100] flex items-center justify-center p-4">
          {/* Backdrop. `bg-black/50` is Tailwind's own palette, not a token —
              opacity modifiers work there (they do NOT on token colors). */}
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => handleClose(false)} />

          <div
            role="dialog"
            aria-modal="true"
            aria-label={state.options.title || 'Confirm'}
            className="dui-dialog relative w-full max-w-sm rounded-xl p-6"
          >
            <button
              onClick={() => handleClose(false)}
              aria-label="Close dialog"
              className="absolute right-4 top-4 text-faint transition-colors hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="flex gap-4">
              <div
                className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${
                  isDanger ? 'dui-dialog-icon-danger' : 'dui-dialog-icon-default'
                }`}
              >
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="mb-1 text-base font-semibold text-fg">{state.options.title}</h3>
                <p className="text-sm leading-relaxed text-muted">{state.options.message}</p>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <Button variant="secondary" onClick={() => handleClose(false)}>
                {state.options.cancelText || 'Cancel'}
              </Button>
              <Button variant={isDanger ? 'danger' : 'primary'} onClick={() => handleClose(true)}>
                {state.options.confirmText || 'Confirm'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
