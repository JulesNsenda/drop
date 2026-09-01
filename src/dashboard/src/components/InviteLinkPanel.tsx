import Button from './ui/Button';
import Input from './ui/Input';

/**
 * The once-only invitation link (DROP-155), shared by `ShareCard` (owner) and
 * `AccessTab` (admin).
 *
 * Shown ONLY when the server says the mail was never sent — which means no
 * SMTP relay is configured on this platform. Not a convenience: the secret
 * exists in plaintext exactly once, in the response to the request that
 * created it, so without this panel an operator with no relay cannot invite
 * anyone at all. The person holding this screen authored the invitation
 * seconds ago and is the one party entitled to the link — the same once-only
 * disclosure a freshly minted API key already gets.
 *
 * The copy handler never claims success without checking. A dashboard on plain
 * HTTP — the same relay-less box that is the only kind ever to see this link —
 * has no `navigator.clipboard` at all, and the operator would go and paste
 * whatever was there before. The secret is not recoverable.
 *
 * `onResult` rather than a banner of its own: the two hosts route their
 * banners differently (`ShareCard` has one, `AccessTab` keeps a separate one
 * per card) and a copy outcome has to land in whichever one sits beside this
 * panel.
 */
function InviteLinkPanel({
  email,
  url,
  onResult,
  onDismiss,
}: {
  email: string;
  url: string;
  onResult: (result: { kind: 'error' | 'ok'; text: string }) => void;
  /** Omitted by hosts that clear the link on their own writes instead. */
  onDismiss?: () => void;
}) {
  const copy = () => {
    const copying = navigator.clipboard?.writeText(url);
    if (!copying) {
      onResult({
        kind: 'error',
        text: 'This browser will not let the page copy for you — select the link and press Ctrl-C.',
      });
      return;
    }
    void copying.then(
      () => onResult({ kind: 'ok', text: 'Invitation link copied.' }),
      () => onResult({ kind: 'error', text: 'Could not copy — select the link and press Ctrl-C.' })
    );
  };

  return (
    <div className="mt-4 rounded border px-3 py-2 text-sm border-line">
      <p className="font-medium">No email was sent</p>
      <p className="mt-1 text-xs opacity-70">
        This platform has no outgoing mail configured, so you need to send {email} this link
        yourself. It can only be used once, and it will not be shown again.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Input type="text" readOnly value={url} onFocus={e => e.target.select()} />
        <Button onClick={copy}>Copy</Button>
        {onDismiss && (
          <Button variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}

export default InviteLinkPanel;
