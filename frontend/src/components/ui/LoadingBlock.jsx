import Spinner from './Spinner.jsx';

/**
 * First-load placeholder. `useResource` starts with `loading: true`, so this is
 * what a page shows before it has any data; a `reload()` leaves stale data in
 * place instead.
 */
export default function LoadingBlock({ label = 'Loading…' }) {
  return (
    // The visible caption is the accessible name, so the Spinner stays silent.
    <div className="loading-block" role="status">
      <Spinner />
      <span className="muted">{label}</span>
    </div>
  );
}
