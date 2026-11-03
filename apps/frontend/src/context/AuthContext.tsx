import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { authApi, Organization, Role, User } from "../api/auth";
import { SESSION_EXPIRED_EVENT } from "../api/http";

interface AuthState {
  user: User | null;
  organization: Organization | null;
  role: Role | null;
}

interface AuthContextType extends AuthState {
  isLoading: boolean;
  isSA: boolean;
  refreshUser: () => Promise<void>;
  logout: () => Promise<void>;
  setAuthData: (user: User, organization: Organization | null, role: Role) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const SIGNED_OUT: AuthState = { user: null, organization: null, role: null };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(SIGNED_OUT);
  const [isLoading, setIsLoading] = useState(true);

  // Mirrors "is someone signed in right now" for event handlers, which would otherwise see stale state.
  const signedInRef = useRef(false);

  // The single path for every auth state change.
  const apply = useCallback((next: AuthState) => {
    signedInRef.current = next.user !== null;
    setState(next);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      apply(await authApi.getMe());
    } catch {
      apply(SIGNED_OUT);
    } finally {
      setIsLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  // The server says the session is gone (expired, revoked, suspended). Only acts while signed in, so a 401
  // while signed out (a wrong password on the login form, the startup /me check) is left alone.
  // The route guard in App.tsx then redirects to /login.
  useEffect(() => {
    const onExpired = () => {
      if (signedInRef.current) apply(SIGNED_OUT);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [apply]);

  const logout = async () => {
    try {
      await authApi.logout();
    } catch {
      // Signed out locally either way.
    } finally {
      apply(SIGNED_OUT);
    }
  };

  const setAuthData = (user: User, organization: Organization | null, role: Role) => apply({ user, organization, role });

  return <AuthContext.Provider value={{ ...state, isLoading, isSA: Boolean(state.user?.isSystemAdmin || state.role === "SA"), refreshUser, logout, setAuthData }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}