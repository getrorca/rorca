/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

function FullScreenSpinner() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div
        aria-label="Loading"
        className="h-10 w-10 animate-spin rounded-full border-4 border-border border-t-accent"
        role="status"
      />
    </div>
  );
}

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <FullScreenSpinner />;
  }

  if (!isAuthenticated) {
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth/login?returnTo=${returnTo}`} replace />;
  }

  return <>{children}</>;
}
