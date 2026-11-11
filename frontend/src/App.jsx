/**
 * The route table.
 *
 * Three tiers, and which tier a page belongs to is decided by what it has to cope
 * with rather than by who it is for:
 *
 * 1. **Standalone and public.** Everything reachable from an email or a phone
 *    camera. These pages own their own `.auth-shell` layout, because whoever is
 *    following the link is often signed out — and for `/scan`, `/enroll` and
 *    `/accept-invite` it is the first SnapAttend page a student ever sees.
 * 2. **Signed in, inside `AppShell`.** The console. `ProtectedRoute` decides
 *    whether there is a session at all, `RoleRoute` decides which tree of it the
 *    user is offered.
 * 3. **The catch-all**, standalone for the same reason as tier 1: the usual way to
 *    reach it is a stale link out of an inbox.
 *
 * `BrowserRouter`, the providers and the outer `ErrorBoundary` are in `main.jsx`,
 * so this file is only the map.
 */
import { Route, Routes } from 'react-router-dom';

import AppShell from './components/layout/AppShell.jsx';
import { ProtectedRoute, PublicOnlyRoute, RoleRoute } from './components/RouteGuards.jsx';
import { Role, STAFF_ROLES } from './lib/constants.js';
import AccountPage from './pages/AccountPage.jsx';
import NotFound from './pages/NotFound.jsx';
import RootRedirect from './pages/RootRedirect.jsx';
import ScanPage from './pages/ScanPage.jsx';
import AcceptInvite from './pages/auth/AcceptInvite.jsx';
import ForgotPassword from './pages/auth/ForgotPassword.jsx';
import Login from './pages/auth/Login.jsx';
import RegisterInstitution from './pages/auth/RegisterInstitution.jsx';
import ResetPassword from './pages/auth/ResetPassword.jsx';
import AdminDashboard from './pages/admin/AdminDashboard.jsx';
import AuditPage from './pages/admin/AuditPage.jsx';
import PrivacyPage from './pages/admin/PrivacyPage.jsx';
import SettingsPage from './pages/admin/SettingsPage.jsx';
import UsersPage from './pages/admin/UsersPage.jsx';
import ReportsPage from './pages/staff/ReportsPage.jsx';
import SessionLive from './pages/staff/SessionLive.jsx';
import SessionsPage from './pages/staff/SessionsPage.jsx';
import StudentDetail from './pages/staff/StudentDetail.jsx';
import StudentsPage from './pages/staff/StudentsPage.jsx';
import SubjectDetail from './pages/staff/SubjectDetail.jsx';
import SubjectsPage from './pages/staff/SubjectsPage.jsx';
import TeacherDashboard from './pages/staff/TeacherDashboard.jsx';
import CheckIn from './pages/student/CheckIn.jsx';
import EnrollPage from './pages/student/EnrollPage.jsx';
import MyAttendance from './pages/student/MyAttendance.jsx';
import StudentDashboard from './pages/student/StudentDashboard.jsx';

export default function App() {
  return (
    <Routes>
      {/* ----------------------------------------------------------------- */}
      {/* Public                                                            */}
      {/* ----------------------------------------------------------------- */}
      <Route path="/" element={<RootRedirect />} />

      {/* The only two that bounce a signed-in visitor home. `Login` is written
          for it: its success handler navigates to `?next=` imperatively, and
          leaves the guard to catch anyone who arrives with a session already. */}
      <Route
        path="/login"
        element={
          <PublicOnlyRoute>
            <Login />
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/register"
        element={
          <PublicOnlyRoute>
            <RegisterInstitution />
          </PublicOnlyRoute>
        }
      />

      {/* Unguarded on purpose, all five, and each for its own reason. The two
          password pages already say so when a session exists and point at
          /account instead; AcceptInvite names whose session it is before letting
          a token overwrite it; and ScanPage and EnrollPage have to gate
          themselves, because PublicOnlyRoute would send the student holding the
          projected code to their dashboard and drop the token they arrived
          with. */}
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/scan" element={<ScanPage />} />
      {/* Outside the shell as well as outside the guards: `EnrollPage` supplies
          its own `<main className="app-content">`, forwards an anonymous holder
          of `?token=` to /accept-invite, and sends anyone else to
          /login?next=/enroll. */}
      <Route path="/enroll" element={<EnrollPage />} />

      {/* ----------------------------------------------------------------- */}
      {/* Signed in                                                         */}
      {/* ----------------------------------------------------------------- */}
      {/* One pathless layout route, so the shell mounts once and stays mounted
          across every navigation inside it. Wrapping each page in its own
          `<AppShell>` would remount the sidebar on every click, which closes the
          mobile drawer mid-tap and re-runs the health check each time. */}
      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        {/* Any role: the password form and, for a student, what the server holds
            of their enrollment. Guarded only by there being a session. */}
        <Route path="/account" element={<AccountPage />} />

        <Route path="/student" element={<RoleRoute roles={[Role.STUDENT]} />}>
          <Route index element={<StudentDashboard />} />
          <Route path="check-in" element={<CheckIn />} />
          <Route path="attendance" element={<MyAttendance />} />
        </Route>

        {/* Flat, not nested under /teacher, because these are the paths
            `Sidebar` links to and an admin uses them as themselves rather than
            as a stand-in teacher: /teacher/subjects would imply two trees
            holding different subjects, and there is only one roster. Scoping is
            the backend's job — every one of these endpoints filters by
            institution and a teacher only ever sees the subjects they own. */}
        <Route element={<RoleRoute roles={STAFF_ROLES} />}>
          <Route path="/teacher" element={<TeacherDashboard />} />
          <Route path="/subjects" element={<SubjectsPage />} />
          <Route path="/subjects/:subjectId" element={<SubjectDetail />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:sessionId" element={<SessionLive />} />
          <Route path="/students" element={<StudentsPage />} />
          <Route path="/students/:studentId" element={<StudentDetail />} />
          <Route path="/reports" element={<ReportsPage />} />
        </Route>

        {/* `index` rather than `path="/admin"` twice: /admin is both a page and
            the prefix of four others, and `Sidebar` marks it `end` so only one
            link lights up. */}
        <Route path="/admin" element={<RoleRoute roles={[Role.ADMIN]} />}>
          <Route index element={<AdminDashboard />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="privacy" element={<PrivacyPage />} />
        </Route>
      </Route>

      {/* Last, and standalone: an unknown path is most often a link from an
          email that has expired, followed by somebody who is not signed in. */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
