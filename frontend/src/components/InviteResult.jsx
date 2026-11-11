import { Alert, CopyField } from './ui/index.js';

/**
 * `invite_response` in `backend/app/routes/_helpers.py` adds `invite_url` only
 * when `mailer.is_configured()` is false — and `/forgot-password` does the same
 * with `reset_url`. So the link is not extra detail on a successful send: its
 * presence means no email exists anywhere and this is the only copy.
 */
function linkOf(result) {
  if (result.invite_url) return { url: result.invite_url, reset: false };
  if (result.reset_url) return { url: result.reset_url, reset: true };
  return null;
}

/**
 * The outcome of inviting a teacher or a student.
 *
 * Reads the recipient off `result` rather than taking it as a prop, because the
 * caller's form state is the address that was *typed* and this is the address
 * the backend actually normalised, created the user under and mailed.
 */
export default function InviteResult({ result, onDismiss }) {
  if (!result) return null;

  const link = linkOf(result);
  const email = result.email || null;
  const name = result.name || null;
  const who = name && email ? `${name} (${email})` : name || email || null;

  if (link) {
    return (
      <Alert
        tone="warn"
        title={
          link.reset
            ? 'No email was sent — this reset link is the only copy'
            : 'No email was sent — this invitation link is the only copy'
        }
        onClose={onDismiss}
      >
        <div className="stack-sm">
          <p>
            This server has no mail account configured, so nothing was delivered. Copy the link and
            pass it on yourself — once you navigate away it is gone.
          </p>

          <CopyField
            label={link.reset ? 'Password reset link' : 'Invitation link'}
            value={link.url}
            hint="Single use, and it expires. Issuing a new one replaces this link and the old one stops working."
          />

          {who ? (
            <p className="small muted">
              {link.reset ? `Reset requested for ${who}.` : `Invitation for ${who}.`}
            </p>
          ) : null}

          {result.created_user === false ? (
            <p className="small muted">
              That address already had an account here, so its outstanding invitation was replaced
              rather than a second account created.
            </p>
          ) : null}
        </div>
      </Alert>
    );
  }

  // Semantics #5: never claim an email was sent when the backend says otherwise.
  // A missing `email_sent` is the `/forgot-password` shape, which reports success
  // generically and omits the field.
  if (result.email_sent === false) {
    return (
      <Alert tone="warn" title="Invitation created, but no email went out" onClose={onDismiss}>
        <div className="stack-sm">
          <p>
            {who
              ? `${who} has an account, but the server did not send the invitation email.`
              : 'The account exists, but the server did not send the invitation email.'}
          </p>
          <p className="small muted">
            Nobody can sign in until they get a link. Resend the invitation from the people list once
            mail is working, or ask an administrator to check the mail settings.
          </p>
        </div>
      </Alert>
    );
  }

  return (
    <Alert tone="success" title="Invitation sent" onClose={onDismiss}>
      <div className="stack-sm">
        {email ? (
          <p>
            We emailed <strong>{email}</strong>.
          </p>
        ) : (
          <p>The invitation is on its way.</p>
        )}
        <p className="small muted">
          Nothing arrives in a few minutes? Have them check spam — a first message from a new sender
          often lands there.
        </p>
        <p className="small muted">You can resend the invitation from the people list.</p>
      </div>
    </Alert>
  );
}
