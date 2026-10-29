---
name: task-end
description: Use at the end of every task, before you report the result to the operator. Runs the repo check bin/check.sh and prints the end-of-task checklist from RULES.md with the check result.
---

# Task end

## What the agent decides

- Whether the repeated procedure from the task is a skill with a script.
- Whether the error from the run is in the register, and whether new knowledge belongs in `memory/` or `decisions/`.
- Whether a skill or artifact reaches beyond the project. If it does, add `scope: shared` to its frontmatter and name it in the report to the operator.

## What the script does

`scripts/task-end.sh` runs `agentic-brain/bin/check.sh` and prints the checklist from the section End of task in `RULES.md`. It marks the check item with the check result. You confirm the other items. The script exits with the exit code of the check.

## Steps

1. Run `agentic-brain/skills/task-end/scripts/task-end.sh`.
2. Fix every error in the output and run the script again.
3. Go through the manual checklist items.
4. Only then report the end of the task.
