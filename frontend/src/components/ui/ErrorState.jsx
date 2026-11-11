import Alert from './Alert.jsx';
import Button from './Button.jsx';
import { ErrorCode } from '../../lib/constants.js';
import { pluralize } from '../../lib/format.js';

/**
 * Turn an `ApiError` into something a human can act on.
 *
 * Two failures need more than `err.message`: a network error, where the real fix
 * is almost always "the Flask process is not running", and a 429, where the user
 * needs to know how long to wait rather than to keep clicking.
 */
function describe(error) {
  // `isNetwork` is status 0 — the request never reached Flask, so whatever
  // generic message the interceptor built says nothing about the cause.
  if (error.isNetwork) {
    return 'Could not reach the server — check that the Flask backend is running on port 5000.';
  }

  const message = error.message || 'Something went wrong.';
  if (error.code === ErrorCode.RATE_LIMITED && error.retryAfter) {
    return `${message} You can retry in ${pluralize(error.retryAfter, 'second')}.`;
  }
  return message;
}

export default function ErrorState({ error, onRetry, title }) {
  // Pages hold the error in state and render this unconditionally; a null error
  // means the last load succeeded.
  if (!error) return null;

  return (
    <Alert
      tone="danger"
      title={title || 'Could not load this'}
      actions={
        // Only offer a retry when the caller can actually perform one.
        onRetry ? (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null
      }
    >
      {describe(error)}
    </Alert>
  );
}
