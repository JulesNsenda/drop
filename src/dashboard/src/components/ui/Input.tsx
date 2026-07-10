import { InputHTMLAttributes, forwardRef, useId } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

/**
 * Design-system input primitive (PRD-045): label + error + focus ring =
 * `--accent`. Forwards all native <input> props. Render inside a `.drop-ui`
 * scope (AppShell / AuthLayout).
 */
const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, id, className = '', ...rest },
  ref
) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const errorId = `${inputId}-error`;

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="mb-1 block text-sm font-medium" style={{ color: 'var(--text-2)' }}>
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        className={`w-full rounded-lg px-3 py-2 outline-none transition-colors dui-input ${
          error ? 'dui-input-error' : ''
        } ${className}`}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      />
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-sm" style={{ color: 'var(--err)' }}>
          {error}
        </p>
      )}
    </div>
  );
});

export default Input;
