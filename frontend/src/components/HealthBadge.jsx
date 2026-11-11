import { useEffect, useRef, useState } from 'react';

import { HealthAPI } from '../lib/api.js';

/** Slow on purpose: this answers a question nobody is asking most of the time. */
const POLL_MS = 60000;

const PRESENTATION = {
  ok: { tone: 'success', label: 'ok' },
  degraded: { tone: 'warn', label: 'degraded' },
  unreachable: { tone: 'danger', label: 'unreachable' },
};

/**
 * `/healthz` reports 200 with `{status: "ok"}` or 503 with `{status: "degraded",
 * checks: {...}}` — see the `healthz()` view in `backend/app/__init__.py`. A check
 * with no `ok` key counts as passing there (`c.get("ok", True)`, which is how
 * `face_crops` behaves), so only an explicit `false` is a failure here too.
 */
function failingChecks(payload) {
  const checks = (payload && payload.checks) || {};
  return Object.keys(checks).filter((name) => checks[name] && checks[name].ok === false);
}

/**
 * Backend liveness, in the sidebar footer. Silent about its own failures: it is a
 * diagnostic, so it changes colour and waits to be noticed rather than raising a
 * toast over whatever the user is doing.
 *
 * `HealthAPI.check()` treats 503 as a valid response, so the degraded body — and
 * with it the names of the broken dependencies — survives to be displayed.
 */
export default function HealthBadge() {
  const [health, setHealth] = useState(null);
  const liveRef = useRef(true);

  useEffect(() => {
    liveRef.current = true;

    async function tick() {
      try {
        const payload = await HealthAPI.check();
        if (!liveRef.current) return;
        setHealth({
          state: payload && payload.status === 'ok' ? 'ok' : 'degraded',
          failing: failingChecks(payload),
          // Named env vars that were never set. Usually the actual cause of a
          // degraded reading, and far more actionable than "mongodb: not ok".
          missing: (payload && payload.missing_settings) || [],
          version: (payload && payload.version) || null,
          environment: (payload && payload.environment) || null,
        });
      } catch {
        if (!liveRef.current) return;
        setHealth({
          state: 'unreachable',
          failing: [],
          missing: [],
          version: null,
          environment: null,
        });
      }
    }

    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      liveRef.current = false;
      clearInterval(timer);
    };
  }, []);

  // Nothing until the first answer: a dot that flashes "unreachable" on every page
  // load would train people to ignore it.
  if (!health) return null;

  const { tone, label } = PRESENTATION[health.state] || PRESENTATION.unreachable;

  let title;
  if (health.state === 'ok') {
    title = ['SnapAttend API', health.version && `v${health.version}`, health.environment]
      .filter(Boolean)
      .join(' · ');
  } else if (health.state === 'degraded') {
    title = [
      health.failing.length
        ? `Degraded: ${health.failing.join(', ')}`
        : 'Degraded: a backend dependency is failing.',
      health.missing.length && `Unset config: ${health.missing.join(', ')}`,
    ]
      .filter(Boolean)
      .join(' — ');
  } else {
    title = 'Could not reach the SnapAttend API.';
  }

  return (
    <span className="row row-sm small muted" title={title}>
      <span className={`health-dot is-${tone}`} aria-hidden="true" />
      {label}
    </span>
  );
}
