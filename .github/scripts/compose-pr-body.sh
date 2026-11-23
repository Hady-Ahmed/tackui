#!/usr/bin/env bash
# Compose the agent PR description into /tmp/pr-body.md.
#
# Shared by two workflows so the PR body is written by exactly one piece of
# code (.github/workflows/agent.yml on fresh runs, agent-iterate.yml on
# comment-driven iterations) — no copies to drift.
#
# Contract (same conventions as agent.yml's artifact steps):
#   env ISSUE_NUMBER            — the issue the PR closes (required)
#   /tmp/summary.md             — the agent's AGENT_SUMMARY.md snapshot (optional)
#   /tmp/opencode.log           — implementer log (fallback when no summary)
#   /tmp/review-unavailable     — marker file (optional conditional section)
#   /tmp/has-questions          — marker file (optional conditional section)
#   /tmp/unresolved-findings.md — file (optional conditional section)
#   Must run from a repo checkout (git merge-base is used).
# Also writes /tmp/gates-run.txt (the gates line, for result comments).
set -euo pipefail

gates_run="npm run lint, npx tsc --noEmit, npm run test (re-run by the workflow on the final code, not the agent's word)"
if git diff --name-only "$(git merge-base main HEAD)" HEAD | grep -q '^agent-builder/'; then
  gates_run="${gates_run}; uv run pytest (agent-builder/ changed)"
fi
printf '%s' "${gates_run}" > /tmp/gates-run.txt

# The agent's summary is template-shaped, so the workflow's only edits to it
# are machine facts, not content: tick the three gate boxes it could not tick
# itself (the gates re-ran here on the final code) and prepend "Closes #N"
# only if the summary does not close the issue itself. No duplicate
# checklist, no duplicate Closes line — the template's own sections are the
# single source.
python3 - <<'PY'
import pathlib, re
src = pathlib.Path("/tmp/summary.md")
if not src.exists():
    raise SystemExit(0)
s = src.read_text()
note = " — verified by this run's gate re-run"
for gate in ("`npm run lint`", "`npx tsc --noEmit`", "`npm run test`"):
    pat = re.compile(r"^(\s*-\s+)\[ \]([^\n]*" + re.escape(gate) + r"[^\n]*)$", re.M)
    s = pat.sub(lambda m: m.group(1) + "[x]" + m.group(2) + note, s, count=1)
pathlib.Path("/tmp/summary-ticked.md").write_text(s)
PY

{
  if [ -f /tmp/summary-ticked.md ]; then
    # Agent-authored summary (AGENT_SUMMARY.md), template-shaped, with the
    # three gate boxes ticked by the machine above.
    if ! grep -Eiq "closes #${ISSUE_NUMBER}|fixes #${ISSUE_NUMBER}|resolves #${ISSUE_NUMBER}" /tmp/summary-ticked.md; then
      echo "Closes #${ISSUE_NUMBER}"
      echo
    fi
    cat /tmp/summary-ticked.md
    echo
  else
    # No summary — old shape: bare Closes, ANSI-stripped log tail, and a
    # machine checklist standing in for the missing one.
    echo "Closes #${ISSUE_NUMBER}"
    echo
    echo "## What the agent did"
    echo
    echo '```'
    tail -c 2000 /tmp/opencode.log | sed -e 's/\x1b\[[0-9;]*[a-zA-Z]//g' -e 's/\r//g'
    echo '```'
    echo
    echo "## Checklist"
    echo "- [x] \`npm run lint\` passes (verified by this run's gate re-run)"
    echo "- [x] \`npx tsc --noEmit\` passes (verified by this run's gate re-run)"
    echo "- [x] \`npm run test\` passes (verified by this run's gate re-run)"
    echo "- [ ] No eslint-disable / @ts-ignore / @ts-expect-error / any, no unlinked TODO comments, docs/changelog/env updated as needed — confirm on review"
    echo
  fi
  echo "## Gates that ran on the final code"
  echo
  echo "${gates_run}"
  if [ -f /tmp/review-unavailable ]; then
    echo
    echo "## Agent review unavailable"
    echo
    echo "The reviewer pass failed this run — the gates (lint, typecheck, full tests) ran, but no agent review findings exist. Treat this PR as unreviewed-by-agent."
  fi
  if [ -f /tmp/has-questions ]; then
    echo
    echo "## Open questions"
    echo
    echo "The agent had unresolved questions while building this — see the review comment below. Scrutinize these areas."
  fi
  if [ -f /tmp/unresolved-findings.md ]; then
    echo
    echo "## Unresolved review findings (agent self-review)"
    echo
    echo "Two review passes ran; these blocking findings were still flagged after the fix pass — judge them yourself:"
    echo
    echo '```'
    cat /tmp/unresolved-findings.md
    echo '```'
  fi
} > /tmp/pr-body.md
