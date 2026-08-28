import { ReactNode, useId } from 'react';
import { cn } from '../../lib/cn';

export interface FieldRenderProps {
  /** Put this on the control; the label's `htmlFor` already points at it. */
  id: string;
  /** Pass to `aria-describedby` so hint and error text are announced. */
  describedBy: string | undefined;
  /** Pass to `aria-invalid`. */
  invalid: boolean | undefined;
}

export interface FieldProps {
  label?: ReactNode;
  /** Guidance shown under the control, announced with it. */
  hint?: ReactNode;
  error?: ReactNode;
  /** Override the generated id (e.g. a `<select>` a test targets by name). */
  id?: string;
  className?: string;
  children: (props: FieldRenderProps) => ReactNode;
}

/**
 * Label + hint + error, wired to a control (DROP-156 PR 4).
 *
 * WHY IT TAKES A RENDER FUNCTION. This exists for the controls `Input` does
 * NOT own — native `<select>`, and anything composite — so it cannot render
 * the control itself. Handing back `{ id, describedBy, invalid }` keeps the
 * wiring explicit and type-checked at each call site, rather than cloning
 * children and hoping the props land somewhere useful.
 *
 * THE DECISION THIS SETTLES. `Input` already carried its own label, error,
 * `aria-invalid` and `aria-describedby`. Adding a second implementation beside
 * it would have meant two places to get the same wiring wrong, so `Input` is
 * rebuilt on this instead — one implementation, and `Input`'s public API
 * (`label`, `error`) is unchanged.
 *
 * `describedBy` is undefined rather than an empty string when there is nothing
 * to describe: `aria-describedby=""` is a dangling reference, which is exactly
 * the failure this series has been removing elsewhere.
 */
function Field({ label, hint, error, id, className, children }: FieldProps) {
  const generated = useId();
  const controlId = id || generated;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('w-full', className)}>
      {label && (
        <label htmlFor={controlId} className="mb-1 block text-sm font-medium text-muted">
          {label}
        </label>
      )}
      {children({ id: controlId, describedBy, invalid: error ? true : undefined })}
      {hint && !error && (
        <p id={hintId} className="mt-1 text-xs text-faint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-sm text-err">
          {error}
        </p>
      )}
    </div>
  );
}

export default Field;
