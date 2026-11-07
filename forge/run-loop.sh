#!/usr/bin/env bash
# Copyright (c) 2026 Rorca Inc.
# SPDX-License-Identifier: Apache-2.0
# Licensed under the Apache License, Version 2.0.
# See LICENSE file in the project root for full license text.

set -euo pipefail

cat >&2 <<'EOF'
forge/run-loop.sh is retired.

It cannot provide the mandatory autonomous process/filesystem/network boundary.
Persist and approve a spec, then use the canonical Rorca pipeline trigger so the
worker launches backend/src/lib/execution-engine.ts under linux-bwrap and the
exact-host model egress broker.
EOF
exit 64
