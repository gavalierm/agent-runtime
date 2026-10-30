---
name: error
description: Use when an error is acknowledged (you and the operator agree something went wrong, an objection was accepted, or you found your own mistake), when you repeated a mechanical step by hand, or when the same thing failed again. Records the error in the register of the brain where it happened, creates a review task on the second occurrence of the same class, and prints the four-sentence report for the operator. Run it after the fix is committed.
---

# Error

The mechanical steps are done by the script, you add only the judgement. The hook `objection_fix.mjs` stops a turn that acknowledges an error without running the script.

## Where the register is

The register is `errors/REGISTER.md` of the brain where the error happened:

- the agent repo, when the error is in the behaviour of the agent,
- the project repo, when the error is in the work on the project,
- the code repo (`agentic-brain/errors/`), when the error is in the code of a repo that carries a brain,
- the global brain, in every other case.

A clone marked `agentic.readonly` (a live clone pulled by a timer) is refused: pass `--brain` with the agent's own write clone of that brain.

One row is one occurrence.

## What the agent decides

- The class: a short key of lowercase letters and hyphens (`manual-download`, `unverified-claim`). The same cause is the same class, also for a different concrete case.
- The fix: the file that governs the behaviour (rules, persona, hook, check, setting). A note in memory is not a fix. Commit the fix before you run the script, the script refuses a file that is not committed so the report can name the commit.
- The mechanism that stops the error next time: `hook:<path>`, `test:<path>`, `deny:<pattern>` or `decision:<id>`. An error that nothing stops is an open error, build the mechanism first.

## What the script does

`scripts/error.sh` adds one row `| date | class | description | fix | test |` to the register: the fix column holds the file, its commit and the mechanism, the test column holds `--check` or, without it, the mechanism. Without a mechanism it exits with code 1 and writes nothing.

```
scripts/error.sh --class <class> --file <fixed file> --mechanism <hook|test|deny|decision>:<ref> [--description "<what I claimed or did>"] [--truth "<what was true>"] [--check "<hook or test that stops it>"] [--brain <folder>]
scripts/error.sh --open
```

The script finds the register from the current folder: `agentic-brain/errors/REGISTER.md` of the repo, else `errors/REGISTER.md` at the repo root, else the register of the global brain. `--brain <folder>` names a brain (or a repo root that has `agentic-brain/`) explicitly. `--open` lists the rows without a fix and writes nothing.

On the second occurrence of the same class in the same register the script creates a review task through the command in `AGENT_TK` (project `agenti`, assignee `ERROR_REVIEWER` or the role `spravca-agentov`) and writes the task number into the fix column. Without `AGENT_TK` it prints that the task is not created and has to be created by hand.

The output is the report for the operator in four sentences: what I claimed or did, what was true (`--truth`, name the mechanism that let it through), which file and commit changed, which check stops it now. Put it into the next reply to the operator, also when the operator does not ask.

## Steps

1. Fix the file that governs the behaviour and commit it.
2. Name the class and the mechanism.
3. Run `scripts/error.sh` with the class, the file and the mechanism.
4. Put the four sentences into the next reply.

## Never

- Do not write an error into `RULES.md` or `PERSONA.md` as a paragraph with a date. The register is the only place of an error. A rule goes into the file without a date and without a task number, and it replaces the existing paragraph.
- Do not acknowledge an error in a reply without running the script.
