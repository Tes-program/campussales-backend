#!/usr/bin/env bash
# Fails if a secret-looking value or an env file is committed (B5 hygiene).
# Runs in CI on tracked files only; prints file:line, never the value itself.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
status=0
if git ls-files | grep -E '(^|/)\.env(\.[a-z]+)?$' | grep -vE '\.env\.example$'; then
  echo "::error::An .env file is tracked by git. Remove it and rotate its secrets."
  status=1
fi
patterns=(
  'postgres(ql)?://[^:@/[:space:]]+:[^@/[:space:]]{6,}@'          # DB URL with password
  'redis://[^:@/[:space:]]*:[^@/[:space:]]{6,}@'
  'cloudinary://[0-9]+:[A-Za-z0-9_-]{10,}@'
  'AKIA[0-9A-Z]{16}'                                # AWS key id
  'xox[baprs]-[0-9A-Za-z-]{10,}'                    # Slack token
  'hooks\.slack\.com/services/T[0-9A-Z]+/B[0-9A-Z]+/[0-9A-Za-z]+'
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
  'sk_live_[0-9A-Za-z]{16,}'
)
for p in "${patterns[@]}"; do
  if git grep -nIE -e "$p" -- . ':!scripts/check-secrets.sh' ':!package-lock.json' ':!yarn.lock' | cut -d: -f1,2; then
    echo "::error::Possible secret matching /$p/ (locations above)."
    status=1
  fi
done
[ $status -eq 0 ] && echo "No secrets found in tracked files."
exit $status
