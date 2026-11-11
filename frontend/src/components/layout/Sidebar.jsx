import { NavLink } from 'react-router-dom';

import { useAuth } from '../../context/AuthContext.jsx';
import { Role, STAFF_ROLES } from '../../lib/constants.js';
import HealthBadge from '../HealthBadge.jsx';

/**
 * Shared attributes for the inline glyphs below. An icon library would be tens of
 * kilobytes for the dozen shapes this app needs, and `currentColor` is what lets a
 * single stylesheet colour them for the active, hover and dark-mode states.
 */
const ICON = {
  viewBox: '0 0 24 24',
  width: 18,
  height: 18,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
};

const IconHome = (
  <svg {...ICON}>
    <path d="M4 10.5 12 4l8 6.5" />
    <path d="M6.5 10v9.5h11V10" />
  </svg>
);

const IconCheck = (
  <svg {...ICON}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 12.3l2.4 2.4 4.6-5" />
  </svg>
);

const IconCalendar = (
  <svg {...ICON}>
    <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
    <path d="M3.5 10h17M8.5 3.5v3M15.5 3.5v3" />
  </svg>
);

const IconFace = (
  <svg {...ICON}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9 10.5h.01M15 10.5h.01M8.8 15c.9 1.1 1.9 1.6 3.2 1.6s2.3-.5 3.2-1.6" />
  </svg>
);

const IconBook = (
  <svg {...ICON}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4z" />
    <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z" />
  </svg>
);

const IconBroadcast = (
  <svg {...ICON}>
    <circle cx="12" cy="12" r="2.5" />
    <path d="M7.4 16.6a6.5 6.5 0 0 1 0-9.2M16.6 7.4a6.5 6.5 0 0 1 0 9.2" />
    <path d="M4.6 19.4a10.5 10.5 0 0 1 0-14.8M19.4 4.6a10.5 10.5 0 0 1 0 14.8" />
  </svg>
);

const IconUsers = (
  <svg {...ICON}>
    <circle cx="9.5" cy="9" r="3.5" />
    <path d="M3.5 19.5c0-3.1 2.7-5 6-5s6 1.9 6 5" />
    <path d="M16 6.6a3.4 3.4 0 0 1 0 6.6M17.5 15c2 .6 3.3 2.1 3.3 4.5" />
  </svg>
);

const IconChart = (
  <svg {...ICON}>
    <path d="M4 20h16" />
    <path d="M7 20v-6M12 20V6M17 20v-9" />
  </svg>
);

const IconShield = (
  <svg {...ICON}>
    <path d="M12 3.5l7 2.5v5.5c0 4.3-2.9 7.5-7 9.5-4.1-2-7-5.2-7-9.5V6z" />
  </svg>
);

const IconSliders = (
  <svg {...ICON}>
    <path d="M4 8h11M19 8h1M4 16h4M12 16h8" />
    <circle cx="17" cy="8" r="2" />
    <circle cx="10" cy="16" r="2" />
  </svg>
);

const IconScroll = (
  <svg {...ICON}>
    <rect x="5" y="3.5" width="14" height="17" rx="2" />
    <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
  </svg>
);

const IconLock = (
  <svg {...ICON}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </svg>
);

/**
 * The navigation, declared once. `roles` is the whole access story for a link —
 * the guard on the route still decides who may *load* the page, this only decides
 * who is offered it.
 *
 * `end` matters on the section overviews: without it React Router marks `/admin`
 * active while you are on `/admin/users`, so two links light up at once. The list
 * pages deliberately omit it, because `/subjects/:id` should keep "Subjects" lit.
 */
const NAV_SECTIONS = [
  {
    title: 'Student',
    items: [
      { label: 'Overview', to: '/student', end: true, roles: [Role.STUDENT], icon: IconHome },
      { label: 'Check in', to: '/student/check-in', roles: [Role.STUDENT], icon: IconCheck },
      {
        label: 'My attendance',
        to: '/student/attendance',
        roles: [Role.STUDENT],
        icon: IconCalendar,
      },
      // /enroll renders outside this shell (it is also a public invite target),
      // but it is still where a student finishes their biometrics.
      { label: 'Enrollment', to: '/enroll', roles: [Role.STUDENT], icon: IconFace },
    ],
  },
  {
    title: 'Teaching',
    items: [
      // Admins see this section too: in practice they run sessions themselves.
      { label: 'Overview', to: '/teacher', end: true, roles: STAFF_ROLES, icon: IconHome },
      { label: 'Subjects', to: '/subjects', roles: STAFF_ROLES, icon: IconBook },
      { label: 'Sessions', to: '/sessions', roles: STAFF_ROLES, icon: IconBroadcast },
      { label: 'Students', to: '/students', roles: STAFF_ROLES, icon: IconUsers },
      { label: 'Reports', to: '/reports', roles: STAFF_ROLES, icon: IconChart },
    ],
  },
  {
    title: 'Admin',
    items: [
      { label: 'Overview', to: '/admin', end: true, roles: [Role.ADMIN], icon: IconShield },
      { label: 'People', to: '/admin/users', roles: [Role.ADMIN], icon: IconUsers },
      { label: 'Settings', to: '/admin/settings', roles: [Role.ADMIN], icon: IconSliders },
      { label: 'Audit log', to: '/admin/audit', roles: [Role.ADMIN], icon: IconScroll },
      { label: 'Privacy', to: '/admin/privacy', roles: [Role.ADMIN], icon: IconLock },
    ],
  },
];

const navLinkClass = ({ isActive }) => (isActive ? 'nav-link is-active' : 'nav-link');

/**
 * `open` is the mobile drawer state, owned by AppShell.
 * `onNavigate` fires on every link tap so the drawer also closes when the tapped
 * link is the page you are already on.
 */
export default function Sidebar({ open = false, onNavigate }) {
  const { institution, role } = useAuth();

  const sections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.roles.includes(role)),
  })).filter((section) => section.items.length > 0);

  return (
    // id is referenced by TopBar's .sidebar-toggle via aria-controls.
    <aside id="app-nav" className={open ? 'app-sidebar is-open' : 'app-sidebar'}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg {...ICON} width={22} height={22}>
            <circle cx="12" cy="9" r="4" />
            <path d="M4.5 20c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5" />
          </svg>
        </span>
        {/* .stack-sm, so the tenant name sits under the product name whatever
            direction the stylesheet gives .brand itself. */}
        <span className="stack-sm">
          <span className="brand-name">SnapAttend</span>
          {/* A multi-tenant console must always say which tenant you are in. */}
          {institution && institution.name ? (
            <span className="brand-org">{institution.name}</span>
          ) : null}
        </span>
      </div>

      <nav className="nav" aria-label="Main navigation">
        {sections.map((section) => (
          <div className="nav-section" key={section.title}>
            <div className="nav-section-title">{section.title}</div>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={Boolean(item.end)}
                className={navLinkClass}
                onClick={onNavigate}
              >
                {item.icon}
                <span>{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <HealthBadge />
        <span className="small faint">SnapAttend v1.0.0</span>
      </div>
    </aside>
  );
}
