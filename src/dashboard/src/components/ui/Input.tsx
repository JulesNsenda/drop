import { InputHTMLAttributes, forwardRef } from 'react';
import { cn } from '../../lib/cn';
import Field from './Field';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** Guidance shown under the control, announced with it. */
  hint?: string;
  error?: string;
}

/**
 * Text input primitive (PRD-045).
 *
 * The label/hint/error scaffolding now comes from `Field` (DROP-156 PR 4)
 * rather than being a second copy of the same wiring — `Input` is just the
 * control. Its public API is unchanged: `label` and `error` behave exactly as
 * before, and `hint` is new.
 *
 * Render inside a `.drop-ui` scope.
 */
const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, id, className, ...rest },
  ref
) {
  return (
    <Field label={label} hint={hint} error={error} id={id}>
      {({ id: inputId, describedBy, invalid }) => (
        <input
          ref={ref}
          id={inputId}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          className={cn(
            'dui-input w-full rounded-lg px-3 py-2 outline-none transition-colors',
            error && 'dui-input-error',
            className
          )}
          {...rest}
        />
      )}
    </Field>
  );
});

export default Input;
