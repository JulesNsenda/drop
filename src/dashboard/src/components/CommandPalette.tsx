import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { LayoutDashboard, Upload, Package, Users, Settings, Box, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog';
import { apiJson } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import type { App } from '../hooks/useApi';
import { cn } from '../lib/cn';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: typeof Box;
  run: () => void;
}

/**
 * Command palette (DROP-156 PR 3c). Cmd-K on macOS, Ctrl-K elsewhere.
 *
 * BUILT ON THE EXISTING `Dialog` RATHER THAN ADDING `cmdk`. The plan named
 * cmdk, but by this point the pieces it would bring are already here: Dialog
 * supplies the portal scope, focus trap, Escape handling and focus restore,
 * all verified in PR 2a. What remained was a filtered list and arrow-key
 * navigation — about eighty lines. Measured context for the call: each Radix
 * primitive so far has cost ~19-27 kB gzipped, so a dependency is not free,
 * and this one would have overlapped almost entirely with what it sits on.
 *
 * The list uses `aria-activedescendant` rather than moving DOM focus: the
 * input must keep focus so typing continues to filter, while the option the
 * user is "on" is still announced. That is the combobox pattern, and it is the
 * reason the options are not themselves focusable.
 *
 * Apps are fetched ONCE PER OPEN, not through `useApps()`. That hook polls on
 * an interval; mounting it here would add a second poller to every page in the
 * dashboard for a surface that is closed almost all of the time.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [apps, setApps] = useState<App[]>([]);
  const navigate = useNavigate();
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const listRef = useRef<HTMLUListElement>(null);

  // Cmd-K / Ctrl-K anywhere. `metaKey` for macOS, `ctrlKey` elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    let cancelled = false;
    apiJson<App[]>('/apps').then((json) => {
      if (!cancelled && json.success && Array.isArray(json.data)) setApps(json.data);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const go = useCallback(
    (to: string) => {
      setOpen(false);
      navigate(to);
    },
    [navigate]
  );

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: 'nav-apps', label: 'Applications', icon: LayoutDashboard, run: () => go('/apps') },
      { id: 'nav-deploy', label: 'Deploy', hint: 'New deployment', icon: Upload, run: () => go('/deploy') },
      { id: 'nav-catalog', label: 'Catalog', icon: Package, run: () => go('/catalog') },
      ...(isAdmin ? [{ id: 'nav-users', label: 'Users', icon: Users, run: () => go('/users') } as Command] : []),
      { id: 'nav-settings', label: 'Settings', icon: Settings, run: () => go('/settings') },
    ];
    const appCmds: Command[] = apps.map((a) => ({
      id: `app-${a.name}`,
      label: a.name,
      hint: a.status,
      icon: Box,
      run: () => go(`/apps/${a.name}`),
    }));
    return [...nav, ...appCmds];
  }, [apps, isAdmin, go]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.hint?.toLowerCase().includes(q)
    );
  }, [commands, query]);

  // Clamp rather than reset: filtering down to fewer results should leave the
  // highlight on something real, not silently jump back to the top mid-typing.
  useEffect(() => {
    setActive((i) => (results.length === 0 ? 0 : Math.min(i, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, results.length]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      results[active]?.run();
    }
  };

  const activeId = results[active] ? `cmd-${results[active].id}` : undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showClose={false}
        widthClassName="max-w-lg"
        className="p-0"
        aria-label="Command palette"
      >
        {/* Radix warns without a Title; the design has no visible heading, so
            this is present for assistive tech only. */}
        <DialogTitle className="sr-only">Command palette</DialogTitle>

        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="h-4 w-4 flex-shrink-0 text-faint" aria-hidden="true" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="cmd-list"
            aria-activedescendant={activeId}
            aria-label="Search commands and apps"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search commands and apps…"
            className="w-full bg-transparent py-3.5 text-sm text-fg outline-none placeholder:text-faint"
          />
        </div>

        <ul id="cmd-list" role="listbox" ref={listRef} className="max-h-80 overflow-y-auto p-1">
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted">No matches</li>
          )}
          {results.map((c, i) => {
            const Icon = c.icon;
            return (
              <li
                key={c.id}
                id={`cmd-${c.id}`}
                role="option"
                aria-selected={i === active}
                data-active={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => c.run()}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded px-3 py-2 text-sm text-fg',
                  i === active && 'bg-surface-2'
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0 text-faint" aria-hidden="true" />
                <span className="flex-1 truncate">{c.label}</span>
                {c.hint && <span className="text-xs text-faint">{c.hint}</span>}
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

export default CommandPalette;
