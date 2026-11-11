/**
 * Session state: who is signed in, and the four ways that changes.
 *
 * This is the only place that decides "anonymous" versus "signed in". Route
 * guards, the sidebar and every role check read it from here, so a token that
 * turns out to be dead has to clear exactly one piece of state.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { AuthAPI, onSessionExpired, tokenStore } from '../lib/api.js';
import { Role, STAFF_ROLES } from '../lib/constants.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // A stored token means there is a /me request to wait for; without one there is
  // nothing to verify, so anonymous visitors never sit behind a loading screen.
  const [initializing, setInitializing] = useState(() => tokenStore.has());

  useEffect(() => {
    if (!tokenStore.has()) {
      setInitializing(false);
      return undefined;
    }

    let cancelled = false;
    AuthAPI.me()
      .then((response) => {
        if (!cancelled) setUser(response.user || null);
      })
      .catch(() => {
        // A token /me refuses is dead weight: keeping it would make every later
        // request spend a round trip discovering the same thing.
        tokenStore.clear();
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setInitializing(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // One failed refresh anywhere in the app (lib/api.js announces it) becomes one
  // sign-out here, rather than each page discovering it on its own next request.
  useEffect(() => onSessionExpired(() => {
    tokenStore.clear();
    setUser(null);
  }), []);

  /**
   * Take the token payload from any of the three sign-in endpoints and adopt the
   * session it describes. `_issue_tokens` in backend/app/routes/auth.py always
   * ships the public user alongside the tokens, so the /me fallback is only
   * insurance against that changing.
   */
  const adopt = useCallback(async (payload) => {
    tokenStore.save(payload);
    if (payload && payload.user) {
      setUser(payload.user);
      return payload.user;
    }
    const response = await AuthAPI.me();
    const fresh = response.user || null;
    setUser(fresh);
    return fresh;
  }, []);

  const login = useCallback(
    async (email, password) => adopt(await AuthAPI.login(email, password)),
    [adopt],
  );

  const registerInstitution = useCallback(
    async (payload) => adopt(await AuthAPI.registerInstitution(payload)),
    [adopt],
  );

  const acceptInvite = useCallback(
    async (token, password) => {
      const response = await AuthAPI.acceptInvite(token, password);
      await adopt(response);
      // The whole response, not just the user: the caller routes on
      // `next_step === 'biometrics'` to send students straight into enrollment.
      return response;
    },
    [adopt],
  );

  const refreshUser = useCallback(async () => {
    const response = await AuthAPI.me();
    const fresh = response.user || null;
    setUser(fresh);
    return fresh;
  }, []);

  const logout = useCallback(async () => {
    try {
      await AuthAPI.logout();
    } catch {
      // Logout is a no-op server side (JWTs are stateless and short-lived), so a
      // network failure is no reason to leave someone stuck signed in here.
    } finally {
      tokenStore.clear();
      setUser(null);
    }
  }, []);

  const role = user ? user.role || null : null;

  const homePath = useCallback(() => {
    if (role === Role.ADMIN) return '/admin';
    if (role === Role.TEACHER) return '/teacher';
    if (role === Role.STUDENT) return '/student';
    return '/login';
  }, [role]);

  const value = useMemo(
    () => ({
      user,
      institution: (user && user.institution) || null,
      student: (user && user.student) || null,
      role,
      isAdmin: role === Role.ADMIN,
      isTeacher: role === Role.TEACHER,
      isStudent: role === Role.STUDENT,
      isStaff: STAFF_ROLES.includes(role),
      initializing,
      login,
      logout,
      registerInstitution,
      acceptInvite,
      refreshUser,
      homePath,
    }),
    [
      user,
      role,
      initializing,
      login,
      logout,
      registerInstitution,
      acceptInvite,
      refreshUser,
      homePath,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    // Naming the fix here is worth the two lines: the alternative symptom is
    // "cannot destructure property 'user' of null" three components deep.
    throw new Error(
      'useAuth() was called outside <AuthProvider>. Wrap the tree in src/main.jsx.',
    );
  }
  return context;
}

export default AuthProvider;
