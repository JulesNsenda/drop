import { useState, useCallback, createContext, useContext, ReactNode } from 'react';
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react';

interface Toast {
  id: number;
  type: 'success' | 'error' | 'info';
  message: string;
}

interface ToastContextValue {
  toast: (type: Toast['type'], message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 0;

const ICONS: Record<Toast['type'], ReactNode> = {
  success: <CheckCircle className="h-5 w-5 text-ok" />,
  error: <AlertCircle className="h-5 w-5 text-err" />,
  info: <Info className="h-5 w-5 text-accent" />,
};

const TONE_CLASS: Record<Toast['type'], string> = {
  success: 'dui-toast-success',
  error: 'dui-toast-error',
  info: 'dui-toast-info',
};

/**
 * App-wide toast stack.
 *
 * SCOPE (DROP-156): this renders as a sibling of {children}, and
 * `ToastProvider` wraps <Routes> in App.tsx — i.e. ABOVE `AppShell` and
 * `AuthLayout`, which are the only elements carrying `.drop-ui`. The stack
 * therefore has to re-establish the token scope on its own root, or every
 * `var(--token)` it uses resolves to nothing. `dui-portal` accompanies it to
 * cancel the opaque `background: var(--bg)` that bare `.drop-ui` sets, which
 * would otherwise paint a filled box behind the stack (see app-ui.css).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((type: Toast['type'], message: string) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="drop-ui dui-portal fixed bottom-4 right-4 z-50 flex flex-col gap-2"
        aria-live="polite"
        aria-atomic="true"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.type === 'error' ? 'alert' : 'status'}
            className={`dui-toast ${TONE_CLASS[t.type]} animate-slide-in flex min-w-[300px] items-center gap-3 rounded-lg px-4 py-3`}
          >
            {ICONS[t.type]}
            <span className="flex-1 text-sm text-fg">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="text-faint transition-colors hover:text-fg"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
