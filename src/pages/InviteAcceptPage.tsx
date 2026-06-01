/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Link } from 'react-router-dom';

export default function InviteAcceptPage() {
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-border bg-panel p-6 text-sm text-muted">
      <h1 className="mb-2 text-lg font-semibold text-text">Invites are unavailable in the OSS edition</h1>
      <p className="mb-4">Rorca OSS runs in local-first single-user mode, so invite flows are not exposed here.</p>
      <Link to="/" className="text-accent hover:underline">Back to Rorca</Link>
    </div>
  );
}
