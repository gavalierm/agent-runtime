---
name: task-end
description: Use at the end of every task, before you report the result to the operator. Runs the brain check (check.sh) for the repo you work in and prints the end-of-task checklist from RULES.md with the check result.
---

# Task end

## What the agent decides

- Whether the repeated procedure from the task is a skill with a script.
- Whether the error from the run is in the register, and whether new knowledge belongs in `memory/` or `decisions/`.
- Whether a skill or artifact reaches beyond the project. If it does, add `scope: shared` to its frontmatter and name it in the report to the operator.

## What the script does

`scripts/task-end.sh` runs `check.sh` of this repo (`brain/bin/check.sh`, in a standalone copy `agentic-brain/bin/check.sh`) with the repo of the current folder as the target, and prints the checklist from the section End of task in the `RULES.md` of that brain. It marks the check item with the check result. You confirm the other items. When the repo has no brain (no `agentic-brain/RULES.md` with `errors/REGISTER.md`, and no `RULES.md` with `errors/REGISTER.md` at the root), the script says so and exits with code 1. Otherwise it exits with the exit code of the check.

## Steps

1. Run `scripts/task-end.sh` of this skill from the repo you work in.
2. Fix every error in the output and run the script again.
3. Go through the manual checklist items.
4. Only then report the end of the task.
