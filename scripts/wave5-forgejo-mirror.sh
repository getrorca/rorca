#!/bin/sh
# Wave 5 GitHub -> Forgejo mirror helper (operator-gated).
#
# Prerequisites (operator-provided, never logged):
#   RORCA_FORGEJO_URL   e.g. https://forgejo.example.com (or ssh://git@forgejo.example.com:2222/org/repo.git)
#   RORCA_FORGEJO_TOKEN  repo-scoped token for https remotes (used as password; suppressed)
#   (or an SSH remote URL + configured SSH key)
#
# Mirrors the refs that landed on GitHub (program branch + main + tags) to the
# Forgejo remote. Idempotent: skips refs that already exist at the same SHA.
set -eu

root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
branch=${RORCA_PROGRAM_BRANCH:-feature/autonomous-implementation-runner-20260804}

[ -n "${RORCA_FORGEJO_URL:-}" ] || { echo "set RORCA_FORGEJO_URL" >&2; exit 64; }
command -v git >/dev/null

forgejo_remote=$(git -C "$root" remote get-url forgejo 2>/dev/null || true)
if [ -z "$forgejo_remote" ]; then
  git -C "$root" remote add forgejo "$RORCA_FORGEJO_URL"
fi

push_refs="refs/heads/$branch:refs/heads/$branch"
if git -C "$root" show-ref --verify --quiet "refs/heads/main"; then
  push_refs="$push_refs refs/heads/main:refs/heads/main"
fi

if [ -n "${RORCA_FORGEJO_TOKEN:-}" ]; then
  # Token auth: use an ephemeral credential URL; never print the token.
  host=$(printf '%s' "$RORCA_FORGEJO_URL" | sed -E 's#https?://([^/]+)/.*#\1#')
  path=$(printf '%s' "$RORCA_FORGEJO_URL" | sed -E 's#https?://[^/]+(/.*)#\1#')
  git -C "$root" -c "credential.https://$host.username=wave5-mirror" \
      -c "credential.https://$host.helper=!f() { echo \"username=wave5-mirror\"; echo \"password=$RORCA_FORGEJO_TOKEN\"; }; f" \
      push "https://$host$path" $push_refs
else
  git -C "$root" push forgejo $push_refs
fi

git -C "$root" push forgejo --tags || true
echo "Forgejo mirror: $branch (+main if present, +tags) mirrored to $RORCA_FORGEJO_URL"
