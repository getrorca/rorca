/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

interface LoginPageProps {
  onSwitchToForgotPassword?: () => void;
}

export default function LoginPage({ onSwitchToForgotPassword: _onSwitchToForgotPassword }: LoginPageProps) {
  return (
    <div className="rounded-xl border border-border bg-panel p-6 text-sm text-muted">
      The OSS edition runs in local single-user mode and does not require a hosted login flow.
    </div>
  );
}
