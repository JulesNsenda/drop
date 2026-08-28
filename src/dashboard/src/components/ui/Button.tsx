import { ButtonHTMLAttributes, forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Design-system button primitive (PRD-045, CVA-ised in DROP-156).
 *
 * Colors stay in `styles/app-ui.css` as `.dui-btn-*` so hover/focus states can
 * be plain CSS pseudo-classes; CVA owns the structural axes (size, shape) and
 * the variant lookup that used to be a hand-rolled `Record<Variant, string>`.
 *
 * Render inside a `.drop-ui` scope (AppShell, AuthLayout, or the node from
 * `PortalScopeProvider`) — outside it the tokens resolve to nothing.
 */
const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 dui-focus-ring',
  {
    variants: {
      variant: {
        primary: 'dui-btn-primary',
        secondary: 'dui-btn-secondary',
        danger: 'dui-btn-danger',
        ghost: 'dui-btn-ghost',
      },
      size: {
        sm: 'px-3 py-1.5 text-xs',
        md: 'px-4 py-2.5 text-sm',
        lg: 'px-5 py-3 text-base',
        icon: 'h-9 w-9 p-0',
      },
      full: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'primary', size: 'md', full: false },
  }
);

export type ButtonVariant = NonNullable<VariantProps<typeof button>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof button>['size']>;

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  loading?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, full, loading = false, disabled, className, children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(button({ variant, size, full }), className)}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
});

export default Button;
