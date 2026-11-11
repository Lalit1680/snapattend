import { useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  LoadingBlock,
  StatGrid,
  StatTile,
} from '../../components/ui/index.js';
import { AdminAPI } from '../../lib/api.js';
import { formatDateTime, formatNumber, pluralize } from '../../lib/format.js';
import useAsync from '../../hooks/useAsync.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import useResource from '../../hooks/useResource.js';
import { useToast } from '../../context/ToastContext.jsx';

/**
 * What this system keeps, and for how long.
 *
 * The point of the page is that the retention rules are *observable* rather than
 * asserted: every figure here is counted live, and one of them
 * (`resolved_but_crop_retained`) is a number that is only ever non-zero when
 * something is broken. That is why it is the first thing on the page and why it
 * is worded as a defect rather than a warning.
 *
 * The counts are server-wide, not per-institution — `privacy_report()` counts the
 * whole collection, and the vector store has one collection for every tenant. The
 * copy says "on this server" for that reason.
 */
export default function PrivacyPage() {
  useDocumentTitle('Privacy');
  const toast = useToast();

  const privacy = useResource(() => AdminAPI.privacy(), []);
  const [sweeping, setSweeping] = useState(false);

  const sweep = useAsync(() => AdminAPI.sweepCrops(), {
    onSuccess: (result) => {
      setSweeping(false);
      const removed = result.crops_discarded || 0;
      if (removed) {
        toast.success(`${pluralize(removed, 'crop')} deleted.`);
      } else {
        toast.info('Nothing was past its expiry — no crop needed deleting.');
      }
      privacy.reload();
    },
    onError: (error) => {
      setSweeping(false);
      toast.notifyError(error);
    },
  });

  const data = privacy.data || null;
  const crops = (data && data.face_crops) || null;
  const vectors = (data && data.vector_store) || null;
  const guarantees = (data && data.guarantees) || [];
  const stale = (crops && crops.resolved_but_crop_retained) || 0;

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-heading">
          <h1 className="page-title">Privacy and retention</h1>
          <p className="page-sub">
            Counted live, not claimed. Everything below is read from the database as this page loads.
          </p>
        </div>
        <div className="page-actions">
          <Button variant="secondary" onClick={privacy.reload} loading={privacy.loading}>
            Re-check
          </Button>
          <Button onClick={() => setSweeping(true)} disabled={!data}>
            Sweep expired crops
          </Button>
        </div>
      </div>

      {privacy.error && !privacy.data ? (
        <ErrorState error={privacy.error} onRetry={privacy.reload} title="Could not read the retention state" />
      ) : privacy.loading && !privacy.data ? (
        <LoadingBlock label="Counting what is stored…" />
      ) : data ? (
        <>
          {/* The invariant, stated as a number. A face crop belongs to an unresolved
              review item and nothing else; one attached to a resolved item means a
              resolution path skipped its own cleanup. */}
          {stale > 0 ? (
            <Alert
              tone="danger"
              title={`${pluralize(stale, 'face crop')} outlived the decision it belonged to`}
              actions={
                <Button size="sm" variant="danger" onClick={() => setSweeping(true)}>
                  Delete them now
                </Button>
              }
            >
              A crop is supposed to be deleted the moment a teacher resolves the review item it came
              from. These were not, which means a code path skipped its cleanup — this is a bug, not a
              setting. Sweeping removes anything past its expiry; if the number stays above zero after
              a sweep, the crops are not yet expired and the deletion on resolve is what failed.
            </Alert>
          ) : (
            <Alert tone="success" title="No crop has outlived its review item">
              Every face crop currently stored belongs to a review item nobody has decided yet. That is
              the invariant this page exists to check.
            </Alert>
          )}

          <StatGrid>
            <StatTile
              label="Review items"
              value={formatNumber(crops.review_items_total)}
              tone="muted"
              meta="on this server, all time"
            />
            <StatTile
              label="Face crops stored"
              value={formatNumber(crops.crops_retained)}
              tone={crops.crops_retained ? 'info' : 'success'}
              meta={crops.crops_retained ? 'awaiting a teacher’s decision' : 'nothing held'}
            />
            <StatTile
              label="Awaiting a decision"
              value={formatNumber(crops.unresolved_items)}
              tone={crops.unresolved_items ? 'warn' : 'success'}
              meta="unresolved review items"
            />
            <StatTile
              label="Crop expiry"
              value={`${formatNumber(crops.crop_ttl_hours)}h`}
              tone="muted"
              meta="deleted even if never resolved"
            />
          </StatGrid>

          <div className="grid grid-2">
            <Card
              title="What is never written down"
              subtitle="These are not low counts. There is no code path that stores them at all, so there is nothing to count."
            >
              <div className="stack-sm">
                <div className="row between">
                  <span>Class photos uploaded for attendance</span>
                  <Badge tone="success">never stored</Badge>
                </div>
                <div className="row between">
                  <span>Enrollment photos and voice recordings</span>
                  <Badge tone="success">never stored</Badge>
                </div>
                <div className="divider" />
                <p className="small muted">
                  A class photo is decoded in memory, matched, and dropped when the request ends. An
                  enrollment sample is turned into a vector and dropped the same way. The only images
                  that persist at all are the cropped faces the photo pipeline could not identify, and
                  only until somebody says who they are.
                </p>
              </div>
            </Card>

            <Card
              title="Vector store"
              subtitle="The embeddings themselves — numbers, keyed by student id, from which no photograph can be reconstructed."
              footer={
                vectors && vectors.persist_dir ? (
                  <p className="small muted">
                    On disk at <span className="mono">{vectors.persist_dir}</span>
                  </p>
                ) : null
              }
            >
              {vectors && vectors.error ? (
                // Reported rather than rendered as zero: "0 embeddings" and "the
                // store did not answer" mean opposite things for attendance.
                <Alert tone="danger" title="The vector store did not answer">
                  <p>
                    Face and voice matching are both unavailable while this is true — a class photo
                    will find no one. The server reported:
                  </p>
                  <pre className="code-block">{String(vectors.error)}</pre>
                </Alert>
              ) : vectors ? (
                <StatGrid>
                  <StatTile
                    label="Face embeddings"
                    value={formatNumber(vectors.face_embeddings)}
                    tone="info"
                  />
                  <StatTile
                    label="Voice embeddings"
                    value={formatNumber(vectors.voice_embeddings)}
                    tone="info"
                  />
                </StatGrid>
              ) : null}
            </Card>
          </div>

          <Card
            title="The guarantees"
            subtitle="Written by the server, from the same source as the counts above."
            footer={
              data.checked_at ? (
                <p className="small muted">Checked {formatDateTime(data.checked_at)}.</p>
              ) : null
            }
          >
            {/* A plain list: `.stack-sm` is a flex column, which blockifies the
                items and drops their bullets. */}
            <ul>
              {guarantees.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Card>

          <Card
            title="Deleting a student's biometrics"
            subtitle="A reset removes the stored vectors, not just the flags that say they exist."
          >
            <p className="small muted">
              Open the student from the Students page and use Reset under enrollment. It deletes the
              face vector, the voice vector, or both, records who did it and why in the audit log, and
              sends the student back to enrolling. Their attendance history is untouched — it belongs
              to the register, not to the biometric.
            </p>
          </Card>
        </>
      ) : null}

      <ConfirmDialog
        open={sweeping}
        title="Delete every expired face crop?"
        message={`Mongo removes them on its own within about a minute of expiry; this does it now and tells you the count. Crops that have not reached ${crops ? `${crops.crop_ttl_hours} hours` : 'their expiry'} yet are left alone — they still belong to a review item nobody has decided.`}
        confirmLabel="Sweep now"
        tone="danger"
        busy={sweep.loading}
        onCancel={() => setSweeping(false)}
        onConfirm={() => sweep.run()}
      />
    </div>
  );
}
