/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';

export interface LocalAuthUser {
  id: string;
  email: string;
  role: 'admin';
  user_metadata: { full_name: string };
  app_metadata: { plan: 'oss' };
  email_confirmed_at: string;
}

interface AuthContextValue {
  user: LocalAuthUser | null;
  session: { access_token: string } | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  signOut: () => Promise<void>;
}

const LOCAL_USER: LocalAuthUser = {
  id: 'local-admin',
  email: 'admin@rorca.local',
  role: 'admin',
  user_metadata: { full_name: 'Local Operator' },
  app_metadata: { plan: 'oss' },
  email_confirmed_at: new Date(0).toISOString(),
};

const LOCAL_SESSION = { access_token: 'local-oss-session' };
const AuthCtx = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const signOut = useCallback(async () => {
    // Local-first OSS mode intentionally keeps the operator attached.
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user: LOCAL_USER,
    session: LOCAL_SESSION,
    isAuthenticated: true,
    isLoading: false,
    signOut,
  }), [signOut]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
