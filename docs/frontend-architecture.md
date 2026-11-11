# SnapAttend frontend architecture

The contract every part of `frontend/src` is written against. It exists because the
UI is built as many small files that have to agree on names: a component that
renders `.btn-primary` and a stylesheet that defines `.button--primary` both look
correct in isolation and produce an unstyled page together.

**The backend is the source of truth for data.** This document is the source of
truth for everything the backend does not dictate: token names, class names,
component props, hook signatures and the route table.

- Stack: React 18, Vite 5, React Router 6, axios. **Plain JavaScript** (`.jsx`), no
  TypeScript, no CSS framework.
- Dev server: `http://localhost:5173`. This is not negotiable — the value is baked
  into `FRONTEND_URL` in `backend/.env`, and from there into every invite email,
  password-reset link and QR code the backend generates.
- One stylesheet: `src/styles/index.css`, imported once from `src/main.jsx`.

---

## 1. Directory layout

```
frontend/
  index.html                  vite entry, mounts #root
  vite.config.js              port 5173, proxies /api -> 127.0.0.1:5000
  .env.example                VITE_API_URL, VITE_PROXY_TARGET, VITE_ENV_LABEL
  public/favicon.svg
  src/
    main.jsx                  ReactDOM root, provider stack, imports the stylesheet
    App.jsx                   the route table and nothing else
    styles/index.css          tokens + every class in section 3
    lib/
      api.js                  axios instance, ApiError, tokenStore, endpoint groups
      constants.js            enums mirrored from the backend
      format.js               dates, percentages, labels
      audio.js                microphone capture -> 16 kHz mono WAV
      camera.js               webcam capture, image downscaling
    context/
      AuthContext.jsx         session state, login/logout, role helpers
      ToastContext.jsx        transient notifications
    hooks/
      useResource.js          load-on-mount data fetching
      useAsync.js             fire-on-demand actions (submits)
      usePolling.js           interval refetch for the live view
      useCountdown.js         seconds remaining until an ISO timestamp
      useDebouncedValue.js    search inputs
      useDocumentTitle.js     per-page <title>
    components/
      ui/                     presentational primitives (section 4)
      layout/                 AppShell, Sidebar, TopBar
      charts/                 TrendChart, BarList
      RouteGuards.jsx         ProtectedRoute, RoleRoute, PublicOnlyRoute
      ErrorBoundary.jsx
      ...domain components    (section 6)
    pages/                    one file per route (section 5)
```

Import style: relative paths, always **with** the extension
(`import Button from '../components/ui/Button.jsx'`). It keeps Vite's resolver
unambiguous and matches the `lib/*.js` imports.

Every component is a **default export**. The six hooks and both contexts export
*both* a named and a default binding, so either import form resolves. Contexts are
always consumed by their named hook (`import { useAuth } from
'../context/AuthContext.jsx'`); the hooks themselves are imported either way
across the tree, and both are correct.

---

## 2. Design tokens

Declared once on `:root` in `src/styles/index.css`. Nothing else defines a colour.

| Token | Light value | Purpose |
| --- | --- | --- |
| `--bg` | `#f6f7fb` | page background |
| `--surface` | `#ffffff` | cards, inputs, modals |
| `--surface-2` | `#f2f4f9` | table headers, subtle fills |
| `--surface-3` | `#e9ecf4` | hover on subtle fills |
| `--border` | `#e2e6ef` | default hairline |
| `--border-strong` | `#cbd2e0` | inputs, focused hairlines |
| `--text` | `#141a2b` | body text |
| `--text-muted` | `#5b657e` | secondary text |
| `--text-faint` | `#8b95ad` | captions, disabled |
| `--primary` | `#4f46e5` | brand, primary actions |
| `--primary-hover` | `#4338ca` | primary hover |
| `--primary-soft` | `#eef0fe` | primary tint background |
| `--on-primary` | `#ffffff` | text on primary |
| `--success` | `#0f9d58` | present, healthy |
| `--success-soft` | `#e6f6ee` | |
| `--info` | `#2563eb` | informational |
| `--info-soft` | `#e8efff` | |
| `--warn` | `#b45309` | manual override, needs attention |
| `--warn-soft` | `#fdf1e3` | |
| `--danger` | `#dc2626` | destructive, below threshold |
| `--danger-hover` | `#b91c1c` | |
| `--danger-soft` | `#fdeaea` | |
| `--radius-sm` | `6px` | badges, small controls |
| `--radius` | `10px` | inputs, buttons |
| `--radius-lg` | `16px` | cards, modals |
| `--radius-full` | `999px` | pills, avatars |
| `--shadow-sm` | `0 1px 2px rgba(20,26,43,.06)` | resting cards |
| `--shadow` | `0 4px 16px rgba(20,26,43,.08)` | raised cards |
| `--shadow-lg` | `0 18px 48px rgba(20,26,43,.18)` | modals, menus |
| `--sidebar-w` | `248px` | |
| `--topbar-h` | `60px` | |
| `--font` | system UI stack | |
| `--font-mono` | `ui-monospace, SFMono-Regular, Menlo, monospace` | tokens, ids, codes |

A `@media (prefers-color-scheme: dark)` block re-declares the same token names
with dark values. Because nothing hard-codes a colour, that block is the entire
dark theme.

**Tone names.** Six tones are used consistently across `Badge`, `Alert`, `StatTile`,
`ProgressBar` and `Toast`: `primary`, `success`, `info`, `warn`, `danger`, `muted`.
A component takes `tone="warn"` and renders the class `is-warn` alongside its base
class. No component invents a seventh tone.

---

## 3. Class inventory

`src/styles/index.css` defines exactly these. Components use exactly these.

**Layout** `.app-shell` `.app-sidebar` `.app-main` `.app-topbar` `.app-content`
`.brand` `.brand-mark` `.brand-name` `.brand-org` `.nav` `.nav-section`
`.nav-section-title` `.nav-link` `.nav-link.is-active` `.nav-badge`
`.sidebar-footer` `.topbar-heading` `.topbar-actions` `.user-chip` `.avatar`
`.menu` `.menu-item` `.menu-separator` `.sidebar-toggle` `.scrim`

**Page** `.page` `.page-header` `.page-heading` `.page-title` `.page-sub`
`.page-actions` `.page-section` `.section-title`

**Auth / standalone** `.auth-shell` `.auth-aside` `.auth-aside-inner`
`.auth-feature` `.auth-panel` `.auth-card` `.auth-header` `.auth-title`
`.auth-sub` `.auth-footer` `.slim-header` `.slim-body`

**Card** `.card` `.card.is-flush` `.card-header` `.card-heading` `.card-title`
`.card-sub` `.card-actions` `.card-body` `.card-footer`

**Button** `.btn` and modifiers `.btn-primary` `.btn-secondary` `.btn-ghost`
`.btn-danger` `.btn-subtle`; sizes `.btn-sm` `.btn-lg`; states `.is-loading`
`.btn-block`; `.btn-group`

**Form** `.field` `.field-label` `.field-required` `.field-hint` `.field-error`
`.field-row` `.input` `.select` `.textarea` `.has-error` `.input-group`
`.input-affix` `.check` `.check-input` `.check-label` `.switch` `.fieldset`
`.legend` `.form-grid`

**Feedback** `.badge` `.badge-dot` `.alert` `.alert-icon` `.alert-content`
`.alert-title` `.alert-actions` `.toast-stack` `.toast` `.toast-body`
`.toast-close` `.spinner` `.spinner-sm` `.spinner-lg` `.loading-block`
`.empty` `.empty-icon` `.empty-title` `.empty-text` `.skeleton`

Tone classes (`.is-primary` `.is-success` `.is-info` `.is-warn` `.is-danger`
`.is-muted`) are defined *scoped to* `.badge`, `.alert`, `.toast`, `.stat`,
`.progress-bar` and `.pill`.

**Table** `.table-wrap` `.table` `.table-compact` `.is-clickable` `.col-right`
`.col-center` `.col-nowrap` `.table-foot` `.row-muted`

**Data display** `.stat-grid` `.stat` `.stat-label` `.stat-value` `.stat-meta`
`.progress` `.progress-bar` `.progress-label` `.pill` `.kv` `.kv-key` `.kv-value`
`.timeline` `.timeline-item` `.timeline-dot` `.timeline-body` `.code-block`
`.copy-field` `.health-dot`

**Overlay** `.modal-backdrop` `.modal` `.modal.is-wide` `.modal-header`
`.modal-title` `.modal-close` `.modal-body` `.modal-footer`

**Tabs** `.tabs` `.tab` `.tab.is-active` `.tab-badge`

**Domain** `.qr-panel` `.qr-frame` `.qr-image` `.qr-meta` `.qr-countdown`
`.capture` `.capture-stage` `.capture-video` `.capture-overlay` `.capture-guide`
`.capture-hint` `.capture-actions` `.thumb-strip` `.thumb` `.thumb-remove`
`.thumb-add` `.level-meter` `.level-fill` `.review-grid` `.review-card`
`.review-crop` `.review-crop-missing` `.review-body` `.review-actions`
`.dropzone` `.dropzone.is-active` `.photo-result` `.match-list` `.match-row`
`.bar-list` `.bar-row` `.bar-label` `.bar-track` `.bar-fill` `.bar-value`
`.chart` `.chart-svg` `.chart-legend` `.legend-item` `.legend-swatch`
`.chart-empty` `.mode-option` `.mode-option.is-selected`

**Utilities** `.stack` `.stack-sm` `.stack-lg` `.row` `.row-sm` `.row-wrap`
`.row-end` `.between` `.center` `.grow` `.grid` `.grid-2` `.grid-3` `.grid-4`
`.divider` `.muted` `.faint` `.small` `.strong` `.mono` `.nowrap` `.truncate`
`.text-right` `.text-center` `.sr-only` `.hide-sm` `.only-sm`

`.stack` is `display:flex; flex-direction:column; gap:1rem`. `.row` is
`display:flex; align-items:center; gap:.75rem`. `.between` adds
`justify-content:space-between`. These four cover most spacing; components should
not carry ad-hoc inline styles except for genuinely dynamic values (a bar's width,
a chart's path).

**Responsive.** One breakpoint at `900px`. Below it the sidebar becomes an
off-canvas drawer toggled by `.sidebar-toggle`, `.hide-sm` hides, `.only-sm`
shows, `.grid-2/3/4` collapse to one column, and `.stat-grid` goes to two.

---

## 4. UI primitives (`src/components/ui/`)

Exact props. A page that needs something else composes these rather than adding a
prop.

| File | Signature |
| --- | --- |
| `Button.jsx` | `({variant='primary', size='md', loading=false, block=false, icon=null, type='button', className='', children, ...rest})` — `variant` ∈ primary/secondary/ghost/danger/subtle; `size` ∈ sm/md/lg. `loading` adds `.is-loading`, renders a `Spinner`, and sets `disabled`. |
| `Card.jsx` | `({title, subtitle, actions, footer, flush=false, className='', children})` — omits `.card-header` entirely when `title` and `actions` are both absent. |
| `Badge.jsx` | `({tone='muted', dot=false, children})` |
| `Alert.jsx` | `({tone='info', title, actions, onClose, children})` |
| `Field.jsx` | `({label, hint, error, required=false, htmlFor, children})` — the label/hint/error wrapper the other inputs use. |
| `Input.jsx` | `({label, hint, error, required, id, className='', ...inputProps})` — forwards ref. |
| `Select.jsx` | `({label, hint, error, required, id, options=[], placeholder, className='', ...selectProps})`; `options` are `{value, label, disabled?}`. |
| `Textarea.jsx` | same as `Input` plus `rows=3`. |
| `Checkbox.jsx` | `({label, hint, checked, onChange, disabled, id})` |
| `Table.jsx` | `({columns, rows, rowKey, empty, loading, compact=false, onRowClick, footer})`. `columns` are `{key, header, render?, align?, width?, nowrap?}`; `render(row, index)` returns a node. `rowKey` is a string field name or `(row) => key`. Renders `EmptyState` when `rows` is empty. |
| `Modal.jsx` | `({open, title, onClose, footer, wide=false, closeOnBackdrop=true, children})` — closes on Escape, restores focus, locks body scroll. Renders `null` when `open` is false. |
| `ConfirmDialog.jsx` | `({open, title, message, confirmLabel='Confirm', cancelLabel='Cancel', tone='danger', busy=false, onConfirm, onCancel, children})` |
| `Spinner.jsx` | `({size='md', label})` — `size` ∈ sm/md/lg. |
| `LoadingBlock.jsx` | `({label='Loading…'})` |
| `EmptyState.jsx` | `({title, message, icon, action})` |
| `ProgressBar.jsx` | `({value, max=100, tone='primary', label, showValue=false})` |
| `StatTile.jsx` | `({label, value, meta, tone='muted', icon})` |
| `StatGrid.jsx` | `({children})` |
| `Tabs.jsx` | `({tabs, active, onChange})`; `tabs` are `{key, label, badge?}`. |
| `Pill.jsx` | `({tone='muted', children})` |
| `CopyField.jsx` | `({value, label, hint})` — read-only input plus a copy button. Used wherever the backend echoes an `invite_url` or `reset_url` (which it only does when SMTP is unconfigured). |
| `ErrorState.jsx` | `({error, onRetry, title})` — renders an `ApiError` as a `danger` alert; special-cases `isNetwork` with "check the backend is running". |

`ui/index.js` re-exports all of them so pages can
`import { Button, Card, Table } from '../components/ui/index.js'`.

---

## 5. Routes and pages

`App.jsx` holds the table below and no logic. Guards come from
`components/RouteGuards.jsx`:

- `ProtectedRoute` — requires a session; otherwise redirects to `/login` with
  `?next=<pathname>`.
- `RoleRoute roles={[...]}` — requires a session **and** one of the roles;
  otherwise sends the user to their own home (`/admin`, `/teacher`, `/student`).
- `PublicOnlyRoute` — for `/login` and `/register`: an already-signed-in user is
  sent to their home instead of seeing a sign-in form.

| Path | Page file | Access | Notes |
| --- | --- | --- | --- |
| `/` | `pages/RootRedirect.jsx` | any | signed in → role home; anonymous → `/login` |
| `/login` | `pages/auth/Login.jsx` | public only | honours `?next=` |
| `/register` | `pages/auth/RegisterInstitution.jsx` | public only | the only self-service signup |
| `/forgot-password` | `pages/auth/ForgotPassword.jsx` | public | always reports success; shows `reset_url` when the API returns one |
| `/reset-password` | `pages/auth/ResetPassword.jsx` | public | **email link target** `?token=` |
| `/accept-invite` | `pages/auth/AcceptInvite.jsx` | public | **staff invite link target** `?token=` |
| `/enroll` | `pages/student/EnrollPage.jsx` | public + student | **student invite link target** `?token=`; also the biometrics wizard for a signed-in student |
| `/scan` | `pages/ScanPage.jsx` | public (optional auth) | **QR target** `?t=` |
| `/student` | `pages/student/StudentDashboard.jsx` | student | linked from emails |
| `/student/check-in` | `pages/student/CheckIn.jsx` | student | |
| `/student/attendance` | `pages/student/MyAttendance.jsx` | student | |
| `/teacher` | `pages/staff/TeacherDashboard.jsx` | staff | |
| `/subjects` | `pages/staff/SubjectsPage.jsx` | staff | |
| `/subjects/:subjectId` | `pages/staff/SubjectDetail.jsx` | staff | roster + report + trend |
| `/sessions` | `pages/staff/SessionsPage.jsx` | staff | list + create |
| `/sessions/:sessionId` | `pages/staff/SessionLive.jsx` | staff | the live console |
| `/students` | `pages/staff/StudentsPage.jsx` | staff | directory, invite, CSV import |
| `/students/:studentId` | `pages/staff/StudentDetail.jsx` | staff | |
| `/reports` | `pages/staff/ReportsPage.jsx` | staff | defaulters, methods, coverage |
| `/admin` | `pages/admin/AdminDashboard.jsx` | admin | linked from emails |
| `/admin/users` | `pages/admin/UsersPage.jsx` | admin | users + invites |
| `/admin/audit` | `pages/admin/AuditPage.jsx` | admin | |
| `/admin/privacy` | `pages/admin/PrivacyPage.jsx` | admin | retention evidence + alerts |
| `/admin/settings` | `pages/admin/SettingsPage.jsx` | admin | |
| `/account` | `pages/AccountPage.jsx` | any | profile + change password |
| `*` | `pages/NotFound.jsx` | any | |

`/scan`, `/enroll` and the auth pages render **outside** `AppShell` — they are
reached by people who may not be signed in, on a phone, and a sidebar full of
links they cannot use is noise. Everything else renders inside `AppShell` via a
layout route with `<Outlet />`.

**Role homes:** admin → `/admin`, teacher → `/teacher`, student → `/student`.

---

## 6. Domain components (`src/components/`)

| File | Signature | Responsibility |
| --- | --- | --- |
| `CameraCapture.jsx` | `({samples, onCapture, onRemove, maxSamples, minSamples, maxDim, mirror=true, hint})` | Live preview, capture button, thumbnail strip. Owns the MediaStream and stops it on unmount. Captures un-mirrored pixels even when the preview is mirrored. |
| `VoiceRecorderPanel.jsx` | `({passphrase, clips, onRecorded, onRemove, maxClips, busy, buttonLabel})` | Press-to-record with elapsed counter and level meter; converts to WAV via `lib/audio.js`; warns on `tooShort`/`tooQuiet` before accepting a clip. |
| `QrPanel.jsx` | `({sessionId, qr, onRotate, loading})` | The projected code: large PNG from `qr.png_data_url`, `useCountdown` on `qr.expires_at`, manual rotate, and the target URL in small text. |
| `ClassPhotoUploader.jsx` | `({sessionId, onResult, disabled})` | Drop/choose/capture a photo, `prepareImageForUpload`, upload with progress, render the result summary (`faces_detected`, `newly_marked`, `needs_review`, `warnings`). |
| `ReviewQueue.jsx` | `({sessionId, items, roster, onResolved, onDiscardAll})` | One card per unmatched face: crop, reason, best guess, then assign / dismiss / not-a-student. |
| `RosterTable.jsx` | `({rows, onOverride, busyStudentId, showMethod=true})` | The present/absent roster with per-row override and bulk selection. |
| `OverrideDialog.jsx` | `({open, student, present, onConfirm, onCancel, busy})` | Manual override. The reason field is **required** — the API rejects a blank one, and the audit trail is the point. |
| `SubjectPicker.jsx` | `({value, onChange, subjects, includeAll=false, label='Subject'})` | |
| `ModePicker.jsx` | `({value, onChange, disabled})` | Radio cards for the four verification modes, using `MODE_LABELS`/`MODE_HINTS`. |
| `InviteResult.jsx` | `({result, onDismiss})` | After an invite: "email sent" or the `invite_url` in a `CopyField`. |
| `HealthBadge.jsx` | `()` | Polls `/healthz` every 60 s; shows a dot and the degraded reasons. Rendered in the sidebar footer. |
| `charts/TrendChart.jsx` | `({points, threshold, height=220})` | Inline SVG line chart of `analytics.subjectTrend().points`. No chart library. |
| `charts/BarList.jsx` | `({items, tone='primary', valueFormat})` | Horizontal bars; `items` are `{label, value, display?, tone?}`. |

---

## 7. Context

### `context/AuthContext.jsx`

```js
export function AuthProvider({ children })
export function useAuth()
```

`useAuth()` returns:

| Key | Type | Notes |
| --- | --- | --- |
| `user` | object \| null | the `_public_user` shape from `backend/app/routes/auth.py` |
| `institution` | object \| null | `user.institution` |
| `student` | object \| null | `user.student` — present only for students |
| `role` | string \| null | |
| `isAdmin` / `isTeacher` / `isStudent` / `isStaff` | boolean | |
| `initializing` | boolean | true until the first `/api/auth/me` settles |
| `login(email, password)` | `Promise<user>` | saves tokens, loads the user |
| `logout()` | `Promise<void>` | calls the API, clears tokens regardless of the result |
| `registerInstitution(payload)` | `Promise<user>` | signs the new admin straight in |
| `acceptInvite(token, password)` | `Promise<{user, next_step}>` | signs in; `next_step === 'biometrics'` for students |
| `refreshUser()` | `Promise<user>` | re-reads `/api/auth/me` after a change |
| `homePath()` | string | `/admin`, `/teacher` or `/student` |

On mount: if `tokenStore.has()`, call `/api/auth/me`; a failure clears the tokens
and drops to anonymous. It also subscribes to `onSessionExpired` from `lib/api.js`,
so a failed refresh anywhere in the app resets the session in one place.

### `context/ToastContext.jsx`

```js
export function ToastProvider({ children })
export function useToast()
```

`useToast()` returns `{ success, info, warn, error, notifyError, dismiss }`.
`success/info/warn/error` take `(message, { title, duration } = {})` and return an
id. `notifyError(err, fallback)` accepts an `ApiError` and renders its `.message`,
appending a rate-limit hint when `err.code === 'rate_limited'`. Default duration
5000 ms; `duration: 0` pins the toast until dismissed.

---

## 8. Hooks

```js
useResource(loader, deps = [], { immediate = true, onSuccess, onError } = {})
// -> { data, error, loading, reload, setData }
// Cancels in-flight work on unmount. `loader` receives an AbortSignal.

useAsync(fn, { onSuccess, onError } = {})
// -> { run, loading, error, data, reset }
// `run(...args)` resolves with the value and never throws; check `error`.

usePolling(fn, intervalMs, { enabled = true, immediate = true } = {})
// -> { data, error, loading, lastUpdatedAt, refresh, consecutiveErrors }
// Pauses while document.hidden and refetches on visibilitychange. Backs off to
// 3x the interval after 3 consecutive failures so a dead backend is not hammered.

useCountdown(target)            // -> { secondsLeft, expired } — ticks once a second
useDebouncedValue(value, ms)    // -> debounced value
useDocumentTitle(title)         // sets "<title> · SnapAttend"
```

---

## 9. API semantics the UI must respect

These are the places where a reasonable-looking implementation is wrong. All of
them come from the backend's own docstrings.

1. **Check-in outcomes are HTTP 200, not errors.** `POST /api/attendance/qr` and
   `/voice` return `{ok, accepted, status, created, already_present, message, …}`
   with a 200 even when the answer is "no". A voice rejection is
   `{ok: false, accepted: false, can_retry: true, distance, confidence,
   voiced_seconds}`. Render `message`; do not treat it as a thrown error.
2. **Enrollment content failures are HTTP 422** with
   `details: {rejections: [{index, reason, message}], accepted_samples,
   required_samples}`. Show which sample failed and why — "upload failed" makes it
   unfixable.
3. **`GET /api/sessions/:id/live` is the poll endpoint** and is deliberately not
   rate-limited. Poll it every 3000 ms (`LIVE_POLL_MS`). Never poll anything else
   on a timer.
4. **The QR rotates every 30 s** with a one-rotation grace window. `qr.expires_at`
   drives the countdown; the poll response carries a fresh token, so the panel
   updates itself without a separate request.
5. **`invite_url` / `reset_url` only appear when SMTP is unconfigured.** Their
   presence means "there is no email — show the link". Their absence means the mail
   went out. Never claim an email was sent when `email_sent` is false.
6. **A manual override always wins.** Rows carry `was_manual_override` and
   `override_reason`; show both, because a teacher looking at a present row needs
   to know whether a human or a camera put it there.
7. **Overrides require a reason.** `POST /api/attendance/override` rejects a blank
   one. Make the field required in the form rather than discovering it in a 400.
8. **CSV downloads go through `download()` in `lib/api.js`**, which reads the
   filename from `Content-Disposition` (CORS-exposed by the backend). Never build
   a plain `<a href>` to an export endpoint — it would miss the auth header.
9. **Percentages already account for late joiners and skip empty sessions.** Do
   not recompute them client-side; the numbers would disagree with the CSV.
10. **Rate limits are real.** Login is 10/min, class-photo upload 30/hr, voice
    check-in 10/min, enrollment 20/hr. On a 429, show `err.message` and disable the
    submit button until `err.retryAfter` elapses if it is present.
11. **`verification_mode` is immutable after creation** — a PATCH attempt returns
    409. Render it read-only on an existing session.
12. **Review crops are transient.** `crop_available: false` means the TTL expired
    or the item was resolved; render a placeholder, not a broken image.

---

## 10. Conventions

- **Errors.** Never render a raw exception. Catch `ApiError`, then either
  `toast.notifyError(err)` for an action or `<ErrorState error={err} onRetry={…} />`
  for a failed load.
- **Loading.** `useResource` starts `loading: true`; render `<LoadingBlock />` for
  a first load and leave stale data in place on a `reload()`.
- **Empty.** Every list renders `<EmptyState>` with a next action, not a blank box.
- **Destructive actions** go through `ConfirmDialog`: ending a session, disabling a
  user, resetting biometrics, deleting a subject, discarding a review queue.
- **Dates.** Always through `lib/format.js`. The API sends UTC ISO strings; the
  browser renders local time.
- **Accessibility.** Every input has a label (`Field` enforces it). Modals trap
  focus and close on Escape. Icon-only buttons carry `aria-label`. Live regions
  (`aria-live="polite"`) wrap the toast stack and the live-session counters.
- **No secrets in the bundle.** Only `VITE_*` variables are readable, and none of
  them is sensitive.
