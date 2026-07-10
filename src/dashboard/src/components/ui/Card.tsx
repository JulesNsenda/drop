import { HTMLAttributes } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Disable the default padding when the caller wants full control (e.g. a table). */
  padded?: boolean;
}

/**
 * Panel surface primitive (PRD-045). Uses the `.drop-ui` panel/border/
 * elevation tokens — render inside a `.drop-ui` scope (AppShell / AuthLayout).
 */
function Card({ padded = true, className = '', children, ...rest }: CardProps) {
  return (
    <div className={`dui-card rounded-xl ${padded ? 'p-5' : ''} ${className}`} {...rest}>
      {children}
    </div>
  );
}

export default Card;
