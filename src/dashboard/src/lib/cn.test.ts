import { cn } from './cn';

/**
 * `cn` exists so a caller's `className` can override a primitive's defaults
 * instead of the winner being decided by stylesheet order.
 *
 * These pin an ASSUMPTION rather than our own logic: tailwind-merge only knows
 * Tailwind's stock scales, and every color in tailwind-preset.js is a custom
 * name it has never seen. It classifies any `text-*` value that is not a known
 * font-size as a color — which happens to be exactly right for
 * `muted`/`faint`/`fg`/`accent`, so no `extendTailwindMerge` config is needed.
 *
 * That is a property of a third-party package's default config, not of our
 * code, so it can change under us on an upgrade. If these ever fail after a
 * `tailwind-merge` bump, the fix is a custom config in cn.ts — not deleting
 * the test.
 */
describe('cn', () => {
  describe('token colors are not confused with font sizes', () => {
    it.each([
      ['text-muted text-sm', ['text-muted', 'text-sm']],
      ['text-faint text-xs', ['text-faint', 'text-xs']],
      ['text-fg text-base', ['text-fg', 'text-base']],
      ['text-accent text-lg', ['text-accent', 'text-lg']],
    ])('keeps both in %s', (input, expected) => {
      const out = cn(input).split(' ');
      expected.forEach((cls) => expect(out).toContain(cls));
    });
  });

  it('resolves a genuine token-color conflict in favour of the later class', () => {
    expect(cn('text-muted', 'text-fg')).toBe('text-fg');
    expect(cn('bg-panel', 'bg-surface-2')).toBe('bg-surface-2');
    expect(cn('border-line', 'border-line-2')).toBe('border-line-2');
  });

  it('lets a caller override a primitive spacing default', () => {
    // The shape that matters: <Button className="px-3"> must actually win.
    expect(cn('px-4 py-2.5 text-sm', 'px-3')).toBe('py-2.5 text-sm px-3');
  });

  it('keeps non-conflicting utilities from both sides', () => {
    const out = cn('rounded-lg border font-medium', 'w-full').split(' ');
    ['rounded-lg', 'border', 'font-medium', 'w-full'].forEach((c) =>
      expect(out).toContain(c)
    );
  });

  it('handles the conditional forms callers actually use', () => {
    expect(cn('a', false && 'b', undefined, null, ['c', 'd'], { e: true, f: false })).toBe(
      'a c d e'
    );
  });
});
