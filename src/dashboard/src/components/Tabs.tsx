import { useRef, KeyboardEvent } from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';

export interface TabDef {
  id: string;
  label: string;
  icon?: LucideIcon;
}

export interface TabsProps {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  /**
   * Accessible name for the tablist. Several pages render more than one group
   * of controls, so "Tabs" tells a screen-reader user nothing — name the thing
   * the tabs switch between.
   */
  label: string;
}

/**
 * Tab bar (DROP-156 PR 2b).
 *
 * WHY THIS IS NOT RADIX TABS — the deviation is deliberate and worth stating.
 * Radix owns the panels as well as the triggers: `Tabs.Trigger` emits
 * `aria-controls` pointing at a `Tabs.Content` it expects to exist. All three
 * consumers here (AppDetailPage, DeployPage, SettingsPage) render their panel
 * content as SIBLING conditionals outside this component — fifteen branches
 * across two files of 850 and 929 lines. Adopting Radix would mean either
 * restructuring all of that, or shipping `aria-controls` that references
 * elements which do not exist. A dangling ARIA reference is worse than no
 * reference at all, so this implements the tablist contract directly.
 *
 * It is a small, fully-specified contract — unlike a modal, there is no focus
 * trap, no portal and no dismissal logic, which is why hand-rolling is
 * reasonable here and was not for the dialog.
 *
 * What was missing before: the bar was a plain `<nav>` of `<button>`s. No
 * `role="tablist"`, no `role="tab"`, no `aria-selected` — a screen reader
 * announced seven unrelated buttons rather than a tab group with one selected.
 * Arrow keys did nothing, and every tab was a separate Tab stop, so reaching
 * page content behind a seven-tab bar took seven presses.
 *
 * Now: roving tabindex (the bar is ONE tab stop), arrow keys move between
 * tabs, Home/End jump to the ends, and `aria-selected` reports state.
 * Activation follows focus, which is the WAI-ARIA pattern for tabs whose
 * panels are already rendered and cheap to switch.
 *
 * `aria-controls` is deliberately absent until the pages wrap their panels —
 * see above. Everything else in the contract holds without it.
 */
function Tabs({ tabs, active, onChange, label }: TabsProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (index: number) => {
    if (tabs.length === 0) return;
    // Wrap around, which is what the pattern specifies for a horizontal bar.
    const next = tabs[(index + tabs.length) % tabs.length];
    onChange(next.id);
    refs.current[next.id]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = tabs.findIndex((t) => t.id === active);
    if (current < 0) return;

    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        select(current + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        select(current - 1);
        break;
      case 'Home':
        event.preventDefault();
        select(0);
        break;
      case 'End':
        event.preventDefault();
        select(tabs.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div className="mb-6 overflow-x-auto border-b border-line">
      <div
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className="-mb-px flex min-w-max gap-1"
      >
        {tabs.map(({ id, label: tabLabel, icon: Icon }) => {
          const selected = active === id;
          return (
            <button
              key={id}
              ref={(el) => {
                refs.current[id] = el;
              }}
              type="button"
              role="tab"
              id={`dui-tab-${id}`}
              aria-selected={selected}
              // Roving tabindex: only the selected tab is in the tab order, so
              // the whole bar is one stop instead of one per tab.
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(id)}
              className={cn(
                'dui-tab dui-focus-ring flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none',
                selected && 'dui-tab-active'
              )}
            >
              {Icon && <Icon className="h-4 w-4" aria-hidden="true" />}
              {tabLabel}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default Tabs;
