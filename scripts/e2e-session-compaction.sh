#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile_dir="${DSH_HOME:-/home/vilicvane/.dsh}/profiles/test-turn-memory"

if [[ ! -f "$profile_dir/package.json" ]]; then
  echo "turn-memory e2e profile is missing: $profile_dir" >&2
  exit 2
fi

linked_plugin="$(readlink -f "$profile_dir/node_modules/dsh-plugin-turn-memory" 2>/dev/null || true)"
if [[ "$linked_plugin" != "$project_dir" ]]; then
  echo "test-turn-memory profile is not linked to this checkout" >&2
  exit 2
fi

log_file="$(mktemp -t session-compaction-e2e.XXXXXX.log)"
cleanup() {
  rm -f "$log_file"
}
trap cleanup EXIT

set +e
DSH_TOOLS_MODE=native \
TURN_MEMORY_E2E_ARTIFACT_DIR="$project_dir/.tmp" \
timeout 600s npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  --profile test-turn-memory \
  --patch "$project_dir/e2e/session-compaction.patch.yml" \
  "turn-memory session compaction e2e" 2>&1 | tee "$log_file"
status=${PIPESTATUS[0]}
set -e

if [[ $status -ne 0 ]]; then
  echo "session compaction e2e command failed with exit $status" >&2
  exit "$status"
fi

if ! grep -q '^SESSION_COMPACTION_E2E_RESULT=PASS$' "$log_file"; then
  echo "session compaction e2e exited without PASS" >&2
  exit 1
fi
