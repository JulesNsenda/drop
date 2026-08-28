import {
  createContext,
  useContext,
  HTMLAttributes,
  TableHTMLAttributes,
  ThHTMLAttributes,
  TdHTMLAttributes,
} from 'react';
import { cn } from '../../lib/cn';

type Density = 'comfortable' | 'compact';

const DensityContext = createContext<Density>('comfortable');

/** Cell padding per density. Both values already existed in the tree. */
const CELL_PADDING: Record<Density, string> = {
  // AppsPage / UsersPage shape.
  comfortable: 'px-4 py-3',
  // The in-panel tables (ApiKeysTab, DatabaseTab), which sit inside a Card
  // that already supplies horizontal padding. Those files used `py-2` on
  // header cells and `py-2.5` on body cells; unified at 2.5, a 2px change to
  // the header only.
  compact: 'py-2.5 pr-4',
};

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  density?: Density;
}

/**
 * Data-table primitives (DROP-156 PR 2c).
 *
 * COMPOSABLE rather than column-defs, chosen against the real call sites:
 * `UsersPage` has a column that hides below `md` (`hidden md:table-cell`) and a
 * right-aligned actions column. A column-def API would need escape hatches for
 * both on day one, which is the point at which it stops being simpler than the
 * markup it replaces.
 *
 * What this removes: every `<th>` in the tree repeated
 * `className="text-left py-2 pr-4 font-medium"` with
 * `className="text-faint"` — the header colour hand-piped per cell,
 * across four files, because there was no other way to reach the token before
 * the preset landed in PR 1.
 *
 * Density is a variant rather than a per-cell prop because the two paddings in
 * use are a property of WHERE the table sits (full-page vs inside a Card that
 * already pads), not of the individual cell. Passing it once on the root keeps
 * every cell consistent.
 */
export function Table({ density = 'comfortable', className, children, ...rest }: TableProps) {
  return (
    <DensityContext.Provider value={density}>
      <table className={cn('w-full text-sm', className)} {...rest}>
        {children}
      </table>
    </DensityContext.Provider>
  );
}

export function TableHead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={className} {...rest} />;
}

export function TableBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...rest} />;
}

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Header rows get the tinted fill the full-page tables use. */
  header?: boolean;
}

export function TableRow({ header = false, className, ...rest }: TableRowProps) {
  return (
    <tr
      className={cn('border-b border-line', header && 'bg-surface-2', className)}
      {...rest}
    />
  );
}

export interface TableCellProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right' | 'center';
}

const ALIGN: Record<NonNullable<TableCellProps['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

export function TableHeaderCell({ align = 'left', className, ...rest }: TableCellProps) {
  const density = useContext(DensityContext);
  return (
    <th
      scope="col"
      className={cn(CELL_PADDING[density], ALIGN[align], 'font-medium text-faint', className)}
      {...rest}
    />
  );
}

export function TableCell({
  align = 'left',
  className,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center' }) {
  const density = useContext(DensityContext);
  return <td className={cn(CELL_PADDING[density], ALIGN[align], className)} {...rest} />;
}

export default Table;
