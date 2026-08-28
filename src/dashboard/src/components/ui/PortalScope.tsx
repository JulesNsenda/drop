import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

const PortalScopeContext = createContext<HTMLElement | null>(null);

/**
 * The DOM node every portalled surface should mount into.
 *
 * Returns `null` until the provider's node has mounted. Radix's `container`
 * prop treats `null`/`undefined` as "use document.body", so a consumer can
 * pass this straight through — it simply falls back for the one render before
 * the ref lands, which is never a render a user can see a dialog in.
 */
export function usePortalScope(): HTMLElement | null {
  return useContext(PortalScopeContext);
}

/**
 * Owns the one DOM node that portalled UI mounts into (DROP-156).
 *
 * WHY THIS EXISTS. The design tokens live on `.drop-ui`, which PRD-045 §2.1
 * pins to the two layout shells (`AppShell`, `AuthLayout`) and forbids hoisting
 * above the route split. Anything that portals to `document.body` therefore
 * lands OUTSIDE the token scope, where every `var(--token)` resolves to nothing
 * and renders unstyled — no error, no build failure. That is not hypothetical:
 * it is exactly why `Toast` and `ConfirmDialog` carried the tree's worst
 * concentrations of raw `gray-*` classes before PR 1.
 *
 * Every Radix primitive portals by default (Dialog, DropdownMenu, Tooltip,
 * Popover, Select), so each one would re-acquire that bug individually.
 *
 * WHY A CONTAINER NODE RATHER THAN A WRAPPER DIV. Wrapping Radix's `Content`
 * in a `<div className="drop-ui">` inserts an element between the portal root
 * and the content, which fights the positioning Radix does for
 * DropdownMenu/Tooltip/Popover — those measure and place `Content` themselves.
 * Passing this node as `container` gives correct token inheritance and leaves
 * Radix's positioning untouched.
 *
 * WHY APP-LEVEL AND NOT PER-SHELL. `.drop-ui` DEFINES the tokens on the element
 * carrying the class; it does not inherit them from an ancestor. Both shells
 * apply the identical class, and the light/dark switch is driven by `html.dark`
 * globally — so one scope node serves every route, and it is available to
 * providers like `ConfirmProvider` that sit ABOVE the shells in `App.tsx` and
 * therefore could never read a context those shells provided.
 *
 * `dui-portal` accompanies `drop-ui` to cancel the opaque
 * `background: var(--bg)` that the bare class sets (see app-ui.css). The node
 * itself is empty and unpositioned, so it takes no layout space and creates no
 * stacking or transform context — `position: fixed` inside it still resolves
 * against the viewport, which is what Radix's overlays and popovers rely on.
 *
 * WHY THE NODE IS APPENDED TO `document.body` RATHER THAN RENDERED IN-TREE.
 * This was measured, not assumed. Rendering it as JSX puts it inside `#root`,
 * and Radix's modal implementation hides the rest of the page from assistive
 * tech by walking up from its content and `aria-hidden`-ing that chain's
 * siblings. With the content inside `#root`, `#root` is an ANCESTOR of the
 * dialog and so cannot be hidden — the entire app stayed exposed to screen
 * readers behind an open modal, and `aria-modal` was never applied. Verified
 * in headless Chrome: `#root` came back `aria-hidden=null, inert=false`.
 *
 * Appending to `body` makes the scope node a SIBLING of `#root`, which is the
 * arrangement Radix's default (`document.body`) produces — so modal semantics
 * work exactly as they would without a custom container, while the tokens
 * still resolve.
 */
export function PortalScopeProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = document.createElement('div');
    el.className = 'drop-ui dui-portal';
    el.setAttribute('data-drop-portal-scope', '');
    document.body.appendChild(el);
    setNode(el);
    return () => {
      el.remove();
      setNode(null);
    };
  }, []);

  return <PortalScopeContext.Provider value={node}>{children}</PortalScopeContext.Provider>;
}
