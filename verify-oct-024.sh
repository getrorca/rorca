#!/bin/bash
# OCT-024 Verification Script
# Run this after: cd backend && npm install

set -e

echo "=== OCT-024 Verification ==="
echo ""

echo "1. Checking TypeScript compilation..."
cd backend
npx tsc --noEmit
echo "✅ TypeScript compiles without errors"
echo ""

echo "2. Checking node-pty postinstall script..."
npm run postinstall 2>&1 | grep -q "node-pty" && echo "✅ postinstall script runs" || echo "⚠️  postinstall did not warn (node-pty may be built)"
echo ""

echo "3. Checking backend starts with degraded terminal..."
timeout 5 npx tsx src/server.ts 2>&1 | grep -q "node-pty" && echo "✅ Backend logs node-pty status" || echo "⚠️  No node-pty log (may be built)"
echo ""

echo "4. Summary of files changed:"
echo "  - backend/package.json (postinstall script)"
echo "  - backend/src/lib/pty-manager.ts (graceful degradation)"
echo "  - backend/src/routes/terminal.ts (new API routes)"
echo "  - backend/src/server.ts (mount terminal router)"
echo "  - .gitignore (exclude node-pty prebuilds)"
echo "  - CLAUDE.md (documentation)"
echo ""

echo "✅ OCT-024 verification complete"
echo ""
echo "To test 503 response manually:"
echo "  1. Remove node-pty build: rm -rf backend/node_modules/node-pty/build"
echo "  2. Start backend: cd backend && npm run dev"
echo "  3. Create session: curl -X POST http://localhost:3030/api/terminal/sessions -H 'Content-Type: application/json' -d '{\"workspaceId\":1}'"
echo "  4. Should return 503 with PTY_NOT_AVAILABLE error"
