#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# Split literal fragments so this script does not self-match when scanned.
P_HOME_MAXIM="/ho""me/max""im"
P_USERS="/Us""ers/"
P_DESKTOP="Рабо""чий ""стол"
P_WORK_1="fix-""price"
P_WORK_2="m-""letto"
P_TOK_1="gh""o_"
P_TOK_2="gh""p_"
P_TOK_3="github_""pat_"
P_TOK_4="sk""-"
P_TOK_5="AI""za"
P_AWS="AKIA""[0-9A-Z]{16}"
P_PRIV_A="BEG""IN "
P_PRIV_B="PRIV""ATE KEY"
P_PRIV="${P_PRIV_A}.*(RSA |EC |OPENSSH |DSA )?${P_PRIV_B}"
P_AI_CO="Co-Auth""ored-By:"
P_AI_GEN="Genera""ted with"

FORBIDDEN_REGEX="(${P_HOME_MAXIM}|${P_USERS}|${P_DESKTOP}|${P_WORK_1}|${P_WORK_2}|${P_TOK_1}|${P_TOK_2}|${P_TOK_3}|${P_TOK_4}(proj|live|test|ant)-[A-Za-z0-9]{10,}|${P_TOK_5}[0-9A-Za-z_-]{20,}|${P_AWS}|${P_PRIV}|${P_AI_CO}|${P_AI_GEN})"

FAIL=0

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  mapfile -t FILES < <(git ls-files)
  for f in "${FILES[@]}"; do
    case "$f" in
      run/*|*/__pycache__/*|__pycache__/*|*.pyc|*.pyo|*.sock|*.pid|.env|.env.*|*.pem|*.key|dist/*)
        echo "ERROR: Forbidden file tracked in git: $f" >&2
        FAIL=1
        ;;
    esac
  done
else
  mapfile -t FILES < <(find . -type f -not -path './.git/*' -not -path './run/*' -not -path './dist/*' -not -path '*/__pycache__/*' -not -name '*.pyc' | sed 's|^\./||' | sort)
fi

if [ "${#FILES[@]}" -gt 0 ]; then
  if grep -rnEI "$FORBIDDEN_REGEX" "${FILES[@]}"; then
    echo "ERROR: Forbidden secret, personal path, or attribution pattern detected above." >&2
    FAIL=1
  fi
fi

if [ "$FAIL" -ne 0 ]; then
  exit 1
fi

echo "Privacy & hygiene check passed (${#FILES[@]} files scanned)."
