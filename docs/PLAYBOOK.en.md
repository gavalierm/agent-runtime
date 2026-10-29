# Playbook: agents with identity, rules and checks

## 0. Introduction

This guide is for an operator who wants to run several agents (sessions of a language model with their own repo) and
does not want to repeat the same instructions to them again and again. It is also for an agent that got the order "read
this repo, study it and think about how to build a similar mechanism for us". It is not a plugin, and nothing gets
installed from it. It describes what we built, why, and in what order to build it yourself.

The problem is simple. An agent without memory repeats mistakes, asks about things the operator already decided, and
states things it did not verify. Asking it to "be careful next time" does not help, because next time is a new session.
Only two things help: a rule written in a file that is loaded at start, and a check that fails when the agent breaks the
rule.

So the system stands on three things. Rules and decisions are files in git. A mistake the operator acknowledges comes
with a change to the file that governs the behaviour. Whatever a machine can check is checked by a hook or a script, not
by the goodwill of the model.

Each of chapters 1 to 11 has the same structure. Problem says what goes wrong without the mechanism, also for a reader
who does not know our system. When you need it says when not to build the mechanism. Mechanism describes how it works.
How to build it gives steps, a file format and an example, without our code. What it requires from the runtime lists
what the tool the agent runs in must be able to do. Our example shows paths in this repo where you can read the finished
version. Chapter 12 is the order of work for the first week.

The scripts without which the harness would not run (the waker, clean context, messages between agents, the task
manager wrapper) live in the repo `https://github.com/gavalierm/agent-runtime`. The repo is public (D0171). Every mechanism is still described in a way that lets you build it
without that link. The link is a path where you can read the finished code. The scripts for recording a decision and an
acknowledged mistake, the rejection helper and the checks of this repo live there too, in its folders `bin/`, `lib/` and `test/`.
This repo carries no code, only links to it.

Paths are relative to the repo root unless stated otherwise. This repo is a cleaned copy of the private rules repo that
runs in our operation. Paths in the "Our example" parts point into this repo where the file exists, and otherwise into
the private operations repo (deploying it to our server is our business, not part of the guide). The map of the repo is
in `README.md`, read it first. Files that the text mentions and that are not in the repo are described in its table
"What is not in the repo". Do not copy our rules as text. They answer our mistakes, and yours will be different. Copy the
mechanisms, meaning the way a rule is written down, loaded, checked and fixed.

### Glossary

| term | meaning |
|---|---|
| operator | the human who owns the workplace, the agents and the accounts, and decides what they reserved for themselves |
| operator's deputy | an agent with a mandate to decide for the operator within approved limits |
| agent manager | a role that manages personas, rules, hooks and the flow of work of the agents |
| server administrator | an agent with root, does only work that needs root or a sensitive action |
| task manager | a tool with tasks, states and comments, in our case Tasker |
| persona, role | the file `PERSONA.md` in the agent's repo, and a mandate described in `roles/<slug>.md`, independent of the agent's name |
| runtime | the tool the agent runs in, which supplies the model, files and commands, in our case Claude Code |
| session | one run of an agent over a repo, from start to clean context or the end of the process |
| context | all the text the model gets in one call, that is rules, conversation and tool results |
| compaction | shortening of the context, where the runtime replaces the old conversation with a summary |
| hook | a script that the runtime runs on an event (session start, prompt, tool use, end of reply) and that can add text to the context or reject a step |
| memory | the agent's files in the repo (`memory/`) that hold what must survive a session and goes beyond one project |
| skill | a file with a procedure for the agent, and possibly a script, which the agent uses when the task matches its description |
| sub-agent | a second session that the main session starts for one partial piece of work and that returns only the result |
| thread | a persistent session of the agent in its tool (in our case a thread in T3 Code), survives single replies and accepts text sent into it |
| topic thread | another thread of the same agent that runs one topic, the main thread is the one the agent runs in by default |
| turn | one call of the model from input to the end of the reply, the model reads the whole context again each time |
| run | a stretch in which the agent works on one input, can have several turns and tool calls |
| mailbox | a directory of the agent with the subdirectories `inbox` and `processed`, a message is a file |
| waker | a program that delivers a message from the mailbox into the running session of the agent and moves the file to `processed` |
| batch | all waking messages for one thread that the waker sends at once, so they use one turn |
| quiet window | the time without a new waking message (in our case 30 s) after which the batch goes out, so messages that arrive close together travel together |
| message mode | the first line of a message, `odpoveď: čakám`, `nečakám` or `na vedomie` (reply: I wait, I do not wait, for information), says what the sender expects of a reply |
| reply route | a record of which thread the sender wrote from, the waker uses it to deliver the reply to that thread |
| task | a record in the task manager with a project, reason, done condition, assignee, state and comments |
| assignee | the agent or human who does the task and whom the task manager wakes on a change |
| done condition | a note in the task by which you can decide whether it is done, best a command and its expected output |
| blocker | a link "this task waits for that one" with a mandatory reason, when that one closes, this one unblocks |
| clean context | a new session without a conversation, which the agent starts from what is written in files and in the task manager |
| handover | a small file with a summary of the state and the next step, which the agent writes before cleanup and which is inserted into the new session |

### Prerequisites

The scripts in the repo are bash and Node.js 22 or newer. The test command needs that version, `node --test` with file
patterns, and the scripts use only `node:` modules, nothing gets installed.
The hooks are Claude Code hooks (SessionStart, UserPromptSubmit, PreToolUse, Stop). They work only when you wire them
into the Claude Code settings. The repo does not do that for you.
We have the rules clone deployed at fixed paths on our machines. In the text, `<rules clone>` replaces them. Pick your
own path.
We did not verify Windows. The scripts run only through WSL or Git Bash, and without bash and Node they do not run at all.
The mechanisms in the text stand without our scripts too. Following the part "How to build it" in each chapter, you write
them in your own language and your own tool.

## 1. An agent is a persona and memory in git, not a session

### Problem

A model session ends at clean context, at compaction, at restart and when you change machines. What the agent knows only
from the conversation, it does not know afterwards. The operator then explains again who the agent is, what it may do and
what was already agreed. An agent whose behaviour depends on how the session developed is unpredictable.

A second problem appears with several agents. When rules and knowledge live in conversation windows, nobody knows what
each agent knows, and you can neither check it nor roll it back.

### When you need it

You need it when an agent works longer than one session, or when you have several of them. You also need it when you want
to know what changed in its behaviour and why, because the history is in git.

You do not need it for a one-off job that one session finishes. For one agent on one project, an instruction file in the
project root is enough (`CLAUDE.md` in Claude Code). Read the rest of the chapter as a sample of where this leads.

### Mechanism

The agent is a repo in git. It contains the persona (`PERSONA.md`), a file for the runtime that imports the persona, the
memory and its own skills. A session is only one run over this repo. At start the persona and the memory load. What must
survive the session, the agent writes into files, commits and pushes.

The persona says who the agent is, how it works with the operator, what it manages and where its limits are. It has no
names of tools of a specific runtime, so that it can be moved. Rules that another agent needs too are not in it
(chapter 2).

The memory holds facts that go beyond one project, for example where things are stored and who prefers what. Decisions
and procedures belong in the project documents and in the decision register (chapter 4). A lesson from a mistake moves
from memory into the persona, and the memory entry is deleted, because memory is only read at start, while the persona
governs the agent.

Session start is always the same. The agent runs `git fetch origin && git rebase origin/main` in the agent's repo and in
the rules repo, then reads the memory and the mailbox (chapter 8). The command `git pull` is not used. Several sessions
in one clone run fetch at the same time, each writes its own line into the file `.git/FETCH_HEAD`, and pull then fails on
two lines.

The agent signs commits with the name `<Agent> (<machine>)`, so the history shows who made it and where. It always
commits with a list of files after `--`, because several sessions share the index of the clone. A bare `git commit`,
`-a`, `git add -A` and `git add .` are forbidden, because they would take along the unfinished files of another session.
Work is done when `git status --short` is empty after the push.

### How to build it

1. Create a private repo for the agent with its own write key. One key per agent shows who pushed. Secrets belong in
   files with mode `600` outside the repo.
2. Write `PERSONA.md`. The first line is a heading with the name, under it a line with the roles, then sections. Five
   sections are enough. Who I am, how I work with the operator, what I manage, limits, continuity.
3. Write the file for the runtime that imports the persona. For Claude Code it is `CLAUDE.md` in the repo root, and the
   line `@PERSONA.md` inserts the content of the file into the context.
4. Create `memory/` with the index `memory/MEMORY.md`. The index has one line per memory file, a link and one sentence
   about what the file is.
5. Write the start rule (fetch, rebase, memory, mailbox) and the end rule (unfinished work into memory, commit, push)
   into the persona.
6. Turn on a git pre-commit hook that runs the repo checks (chapters 4 and 6). A git hook is a script in `.githooks/`,
   you turn it on with `git config core.hooksPath .githooks`. Without the checks the rules drift apart.
7. Verify it with one test. Have the agent write a fact into memory, commit, clear the context (or start a new session)
   and ask it about that fact.

The file for the runtime:

```
@PERSONA.md

# <Name> on <machine>

This file adds to PERSONA.md only what belongs to a run on this machine.
```

A line of the memory index:

```
- [Where the API secret is](tajomstvo_api.md), the path to the file and who may read it
```

### What it requires from the runtime

- It loads an instruction file from the working directory at start. Claude Code reads `CLAUDE.md`, another tool has a
  different name.
- It can insert one file into another. If it cannot, the runtime file contains the whole persona and you generate it from
  `PERSONA.md` with a script, so the texts do not start living twice.
- It lets the agent into a shell with git and a write key.

### Our example

The start and end rules are in `env/server/CLAUDE.md`, part "Git on the server" (Slovak: "Git na serveri"). The rule on
unfinished work is in `global/CLAUDE.md`, §6. That the persona has no runtime tool names is stated in
`roles/spravca-agentov.md`, part "Persona of agents" (Slovak: "Persona agentov"). The pre-commit hook is
`.githooks/pre-commit`. A sample persona is in the file `PERSONA.md` of the agent manager's repo.

## 2. Layers of rules

### Problem

Rules written in one place grow. A rule that every agent needs gets copied into five personas, and the fifth wording then
differs from the first. A rule about a role, written with an agent's name, stops being valid when the agent is renamed or
another agent takes over the role. On top of that, an agent does not know which of two rules is stronger.

A third problem appears when a rule changes. A session that is already running does not see the new wording. The agent
keeps following the old rule until someone restarts it.

### When you need it

You need it when a rule should apply to more than one agent or more than one project. You also need it with a single
agent, if it works on several machines and each has a slightly different environment.

You do not need it with one agent on one machine. One instruction file and a persona are enough. Add layers when you write
the same rule for a second agent for the first time. Add roles only when you have work that the first agent should not do.

### Mechanism

Rules have five layers, from the widest to the narrowest. A narrower layer takes precedence over a wider one.

| layer | file | applies to |
|---|---|---|
| global | `global/CLAUDE.md` | every agent everywhere |
| environment | `env/<environment>/CLAUDE.md` | every agent on this machine |
| role | `roles/<slug>.md` | an agent whose persona lists the role |
| persona | `PERSONA.md` in the agent's repo | one agent |
| project | `CLAUDE.md` of the project | work in the project, takes precedence |

Loading is hard, not voluntary. Claude Code loads the file `CLAUDE.md` from the user's home directory
(`~/.claude/CLAUDE.md`) and from every parent of the working directory. So you place the global file as a symbolic link
at `~/.claude/CLAUDE.md`, and the environment file as a symbolic link at the root of the tree under which the agents run.
The persona loads by the import `@PERSONA.md` from the runtime file. A hook inserts the roles at session start.

The identity hook runs at session start. It reads the line `Role: <slug>, <slug>` from `PERSONA.md` and inserts the files
`roles/<slug>.md` into the context. An agent whose persona lists no role does not get its rules. An unknown slug gives a
warning in the context, and the hook does not crash. The same hook also announces the identity, meaning the name from the
persona heading and the shortened session id.

A change of rules reaches the agent in the middle of a session too. On every prompt, a hook compares the commit the
deployed rules clone is on with the commit this session saw last. If they differ, it inserts into the context a list of
commits and a diff of the files in `global/` and `env/<environment>/`. The state of the last seen version is kept in one
file per session, so sessions do not affect each other. The first prompt of a session only writes the commit, because the
files were loaded fresh at start. So a change applies at most five minutes after the push and without a restart, if the
deployed clone updates itself every five minutes.

A role rule and an agent's name each have a single place. You write a rule for a role or a group of agents. A single file
that maps roles to names says who holds a role. Renaming an agent is a change of one line and of the repo name, and the
rules do not change. A name belongs only in an example or in a description of a state with a date. A role is a mandate and
a responsibility, not system privileges.

A rule belongs at the level of its reach. If another agent needs it too, or another agent holds a copy, it belongs in the
global rules, the environment or a role. Two checks enforce this. The first looks for duplicates, meaning bullets in
personas that say the same as bullets in the shared files. The second is a hook that, on the first write of new text into
an agent's rules, rejects the write with the question whether another agent does the same thing. The identical second
write passes, so the hook only forces a pause.

The global rules have a word cap that may only go down. Shorter rules are followed better, and every word costs tokens on
every model call.

### How to build it

1. Write `global/CLAUDE.md`. Start short (chapter 12) and keep it under a cap that you set. The cap is a number in a file,
   for example `1500`, and a check counts the words of the file and fails when there are more than the number. The number
   may only go down, so the check also compares with the state in the previous commit.
2. Link it. In Claude Code it is `ln -s <rules clone>/global/CLAUDE.md ~/.claude/CLAUDE.md`. The line in the persona looks
   like `Role: zastupca-operatora, spravca-agentov`.
3. Write `env/<environment>/CLAUDE.md` for things typical of the machine and link it to the root of the agent tree, for
   example `ln -s <rules clone>/env/server/CLAUDE.md /home/agents/CLAUDE.md`.
4. With several roles, write `roles/ROLES.md` as an index and `roles/<slug>.md` for each one. Put the mapping of roles to
   names in one file, for example `roles/agents.md`, and write names nowhere else.
5. Write a SessionStart hook that reads the `Role:` line and prints the role files to standard output. At SessionStart the
   output of the hook is added to the context.
6. Write a UserPromptSubmit hook with the clone diff. The hook does this.
   1. Take `session_id` from the JSON on input.
   2. Find `git rev-parse HEAD` of the deployed clone.
   3. Read the state file for this session. If it does not exist, write HEAD and exit without output.
   4. If HEAD matches, exit. Otherwise write it and print `git log --format='%h %s' <old>..<new> -- global/ env/<environment>/`
      and `git diff <old>..<new> -- global/ env/<environment>/`, at most 20 kB.
7. Make sure the rules clone updates itself. A timer (cron or systemd) that runs `git fetch origin && git merge --ff-only origin/main`
   every five minutes is enough.
8. Write a deployment script that sets up the links, hooks and timer in a repeatable way.
9. Add a duplicate test to the repo check. Split the rules into units (a bullet or a paragraph), strip diacritics,
   punctuation and short words, cut words to five characters and report a pair of units where at least three quarters of
   the smaller one match.

### What it requires from the runtime

- It loads instructions from the user's home directory and from all parents of the working directory, or gives you another
  way to insert a global file into every session.
- It supports hooks at session start and on every prompt, whose output is added to the context.
- It gives the hook an input with the session id and the working directory. The hook stores state by the session id.
- It imports a file from a file (`@PERSONA.md`), or adds personas in another way.

### Our example

The table of layers is in `README.md`. The role index is `roles/ROLES.md`, and the role rules are
`roles/zastupca-operatora.md`, `roles/spravca-agentov.md`, `roles/pracovny-agent.md` and `roles/dizajner.md`. The hooks are
[hooks/identity.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/identity.mjs), [hooks/rules_delta.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/rules_delta.mjs) and [hooks/own_rule_scope.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/own_rule_scope.mjs). Deployment is done by
`env/server/install.sh`, duplicates are found by `lib/rule_dupes.mjs`, and the word cap is held by
`lib/global_word_cap.txt`. The rule "an instruction against a rule" is the record `rozhodnutia/D0144.md`. These four files
are not in the repo, they are tied to our runtime or private. What they do is in the table "What is not in the repo"
in `README.md`.

## 3. The operator and the deputy

### Problem

The operator has little time. An agent that asks about everything delays them. An agent that asks about nothing does even
what the operator reserved. Asking about things the agent can settle itself is also a hidden mistake, because it passes as
caution.

When there are several agents and each asks the operator on its own, the operator becomes a postman between them, and
nobody knows what is currently waiting for what. Questions get lost in conversations.

### When you need it

You need it when agents work for a long time without supervision and the operator has no time to approve every step. You
need it when the operator reserved something (payments, new services, steps that cannot be undone) and the agent must know
it before it touches production.

You do not need it when you work with one agent and sit next to it. Then you decide, and the agent asks in the
conversation. With three or more agents and no deputy, you end up as a secretary who moves questions around.

### Mechanism

The operator's deputy is an agent with a mandate to decide for the operator where the operator does not decide alone, within
limits the operator approved. The mandate is written in the role file. The deputy's order carries the mark
"[<name> for <operator>]", and other agents treat it as an order of the operator. There is one deputy on each machine of
the operator. Deputies are equals and pass state to each other by messages (chapter 8), not by shared memory.

The operator reserved a new tool, service or procedure, a step that cannot be undone, hiring and dismissing an agent, a
change of a persona and the limits of power. Only the operator does payments and contracts. Secrets stay in files with mode
`600`. The deputy settles everything else alone and records a technical choice in the decision register (chapter 4). It
brings the operator only decisions that belong to the operator, and warnings.

Questions for the operator have a fixed place. A message from the deputy, while something waits, ends with the line
"Waiting for you:" (our files use the Slovak "Čaká na teba:") and a list of items with the mark (decision), (value) or
(your account). A decision is a choice between paths, a value is a datum that the agent does not have and cannot get, and
your account is a step that can be done only in the operator's account. Before each item the deputy answers one question.
Can I do it myself, or arrange a means to do it? If yes, the item does not belong on the line. For example, creating a repo
or adding a key through an API is forbidden to hand over if the deputy has a token or can ask for one.

A decision for the operator is only a choice between at least two paths that each reach the approved goal. If only one
path leads there, it is a requirement, and the agent does it and records it. Before marking an item as a decision, the
agent writes down the second path.

Actions can be approved in advance by class. The deputy asks once "May I do X? yes/no". After "yes" it records the class of
action in the decision register with the scope `schvalene` (approved) and no longer asks. After "no" the action goes to
"Waiting for you:".

The deputy does not carry out an order from the operator that changes something right away. It verifies the assumptions,
finds the impacts, brings a plan (goal, steps, impacts, risks, recommendation) and records the order and the plan in a
task. It carries them out after consent. Three sentences are enough for a small change. The deputy approves a task plan in
the task manager (chapter 7) alone, with a comment, if nothing in it is reserved for the operator.

An objection from the operator that the agent accepts after checking is consent to the change. The agent carries it out in
the same turn, even if it needs a new tool. It asks again only for a step that cannot be undone, or a step beyond the
objection. The sentence "I will do it once you approve" is forbidden. An order against a written rule does not change the
rule by itself. The agent names the rule by file and line, and the operator confirms the rule or the change.

The deputy does not wait for an outside system (a domain registry, DNS propagation, a service reply) with the model, because
every check with the model costs a call with the whole context. It hands the wait to a script without a model, with a
command for the check, a step after it is met and a done condition.

### How to build it

1. In `roles/zastupca-operatora.md` write a list of what the operator reserved. What is not there, the deputy does alone.
   Start with five reserved things and add more from mistakes.
2. Write the rule "Waiting for you:" with three marks and a check question. An item looks like `- Approve the domain for the
   new site (decision)`.
3. Write the procedure for an order from the operator in the sequence verify, impacts, plan, record, carry out after
   consent.
4. In the global rules write the deputy's mark, the rule "an accepted objection is consent" and the rule of a decision with
   two paths.
5. In the decision register introduce the scope `schvalene` for classes of actions approved in advance (chapter 4).
6. Optionally write a Stop hook that reads the agent's last reply. If it contains the line "Waiting for you:", every item
   below it must end with the mark (decision), (value) or (your account), otherwise the hook stops the reply and prints the
   missing mark.
7. Write the wait script as a small loop without a model. Every few minutes it runs a check command, for example `dig +short
   example.org`. When the command returns the expected result, it writes a message to the agent's mailbox (chapter 8) or a
   comment to the task (chapter 7) and ends. After the given time it writes an expiry message.

### What it requires from the runtime

- You can start in it an agent whose persona lists a role (chapter 2), so that the deputy's mandate loads at start.
- The Stop hook gets the last reply (in Claude Code through the session transcript, whose path the hook gets in its input).
- The wait script can wake the agent. That is either a message in a mailbox with a waker (chapter 8), or a comment in the
  task manager that wakes the assignee (chapter 7).

### Our example

The role is described in `roles/zastupca-operatora.md`, parts "What it does alone and what waits for the operator" ("Čo
urobí sám a čo čaká na operátora"), "Order from the operator" ("Zadanie od operátora"), "Limits" ("Hranice") and
"Continuity" ("Kontinuita"). What the operator reserved is in `roles/ROLES.md`. The decision with two paths is in
`global/CLAUDE.md`, §6, the accepted objection in §1. The line "Waiting for you:" is checked by [hooks/reply_guard.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/reply_guard.mjs) with
the variable `AR_ROZHODNUTIA=1`. The scope `schvalene` is in `rozhodnutia/ROZSAHY.md`.

## 4. Decision register

### Problem

A decision spoken in conversation dies with the session. A week later the agent asks again or does the opposite. Notes in
one big file cannot be checked, and an old decision gets replaced by a new one without fixing the places that still state
the old one. Agent instructions then claim things that stopped being true long ago.

### When you need it

You need it when an agent repeatedly asks about things you already decided, or when rules change and the old wordings
remain in personas, memory and documents. You also need it when you want to know about a decision who made it and with
what power.

You do not need it with one agent and ten rules. One file with bullets in the repo is enough then. Create the register when
you find two claims in the instructions that contradict each other, or when an agent acts on a decision that no longer
holds.

### Mechanism

A decision is one file in `rozhodnutia/` (Slovak for "decisions"), named `D0001.md`, `D0002.md` and so on. The header is a
list of `key: value` fields between two `---` lines, followed by a short body. A file is never deleted, and a change of
state is a commit. The field names and enum values below are written as they appear in our files.

| field | meaning |
|---|---|
| `id` | `D` and four digits, equal to the file name |
| `nazov` | title, one sentence saying what holds |
| `stav` | state: `platí` (valid), `nahradené` (replaced) or `zrušené` (cancelled) |
| `kluc` | key, a dotted path of one subject, for example `odpoved.strop-viet`, unique among valid records |
| `rozsah` | scope, tags from `rozhodnutia/ROZSAHY.md`, meaning the topics the decision touches |
| `agenti` | agents, names in lower case, or `*` |
| `rozhodol`, `moc` | who decided, and with what mandate (operator, deputy, agent manager and so on) |
| `zapisal`, `datum` | who wrote the record and when |
| `zdroj` | source, where it was said, for example a thread, a message or a task |
| `nahradza`, `nahradene` | links between records (replaces, replaced by), both sides point at each other |
| `subory` | files of the repo that embody the decision, they must exist |
| `zrusene-tvrdenie` | cancelled claim, a regular expression of a sentence that must not stand anywhere after the change |

The body has at most five sentences. It says what holds, why, and what was rejected. The history is in git.

The key prevents two valid records about one subject. The write script fails when a new record with a valid key does not
say that it replaces the old one. The power prevents an agent without a mandate from deciding about rules. The table of
scope and power is in `rozhodnutia/ROZSAHY.md`, and the check enforces it. The file `INDEX.md` is a generated overview of
all records and is not edited by hand.

Writing goes one way. The script [bin/rozhodni.sh](https://github.com/gavalierm/agent-runtime/blob/main/bin/rozhodni.sh) assigns a number, writes the file, rewrites `INDEX.md`, commits under
the agent's name and pushes. A hook that rejects every other write into the records runs before the tool is used. It
catches a write through the file editing tool and a command in the shell, including `sed -i`, redirection and `tee`. The
option `--dry-run` writes nothing, and the option `--zrus` (cancel) cancels a decision.

Cancelled claims are checked by a machine. When a decision changes something, its field `zrusene-tvrdenie` carries a
regular expression of the old sentence. A check scans the agent instructions and the memory and fails at every place that
still states the old sentence. A second check goes through the paths in backticks in the instructions and fails on a path
to a file that does not exist. A third fails on a memory that claims something waits for the operator without a task
number, or mentions a decision without a record number.

An agent learns about decisions from three places. A hook at session start inserts the changes since the last start and the
tasks waiting for the operator. The rules-change hook from chapter 2 inserts a change of a record into the next prompt. And
the agent lists them itself, with `node lib/rozhodnutia.mjs list --agent <name>`.

A remark in a conversation is not a decision. It is written down only after the operator says yes to the text. While they
discuss the matter, no record is written.

### How to build it

1. Create `rozhodnutia/` and `rozhodnutia/README.md` with the schema of the fields.
2. Write `rozhodnutia/ROZSAHY.md` with a table of tags and a table "scope may power". Start with five tags.
3. Write the write script. It assigns the next number (the highest number in the directory plus one), writes the header and
   the body from standard input, runs the check and commits. A write never overwrites an existing file.
4. Write the check. The id equals the file name, the key is unique among valid records, the links `nahradza` and
   `nahradene` point at each other, the files in `subory` exist, the tag is in the table, the power fits the scope.
5. Write a list of cancelled claims and a check that looks for them in the instructions and in the memory. The list can be a
   plain text file where a line is a regular expression, a tab and a reason.
6. Wire a PreToolUse hook that rejects a write into `rozhodnutia/` outside the script. The hook rejects a write tool whose
   path leads to a record `rozhodnutia/D0xxx.md`, and a shell command that mentions such a record together with `sed -i`,
   `tee` or redirection. The rejection carries the line "Correct procedure:" (our files use "Správny postup:", chapter 6).
7. Wire a SessionStart hook with the changes since the last start and run the check in the pre-commit hook.

A record:

```
---
id: D0001
nazov: Odpoveď operátorovi má najviac šesť viet
stav: platí
kluc: odpoved.strop-viet
rozsah: pravidla
agenti: *
rozhodol: <operator name>
moc: operator
zapisal: <agent>
datum: <YYYY-MM-DD>
zdroj: <thread or task where it was said>
subory: <path of the file that enforces the rule>
---
A reply to the operator has at most six sentences of prose. The reason is that the operator does not read a long reply.
A cap of twelve sentences was rejected, because agents reached it regularly.
```

### What it requires from the runtime

- PreToolUse and SessionStart hooks that can add text to the context or reject a tool with a reason (chapter 6).
- The PreToolUse hook also sees shell commands, not only writes through the file editing tool. If the runtime does not show
  shell commands to hooks, you will not catch a write through `sed`, and you guard it with a check in the pre-commit hook.
- Access to git and the ability to push under the agent's name.

### Our example

The schema is in `rozhodnutia/README.md`, the tags in `rozhodnutia/ROZSAHY.md`. Sample records are `rozhodnutia/D0141.md`,
`rozhodnutia/D0142.md` and `rozhodnutia/D0144.md`, which replaces `rozhodnutia/D0010.md`. Writing is done by
[bin/rozhodni.sh](https://github.com/gavalierm/agent-runtime/blob/main/bin/rozhodni.sh), the logic and the check by [lib/rozhodnutia.mjs](https://github.com/gavalierm/agent-runtime/blob/main/lib/rozhodnutia.mjs) with the test [test/rozhodnutia.test.mjs](https://github.com/gavalierm/agent-runtime/blob/main/test/rozhodnutia.test.mjs). Cancelled
claims are read by `lib/doc_paths.mjs` from the file `lib/retired_claims.txt`, and the memory is checked by
`lib/memory_claims.mjs`. The hooks are `hooks/rozhodnutia_guard.mjs` and `hooks/rozhodnutia_context.mjs`. The records D0010,
D0141, D0142 and D0144, the scripts `lib/doc_paths.mjs` and `lib/memory_claims.mjs`, the list `lib/retired_claims.txt` and
both `rozhodnutia_*` hooks are not in the repo. The records are private, and the rest is tied to our tasks and memory. What
they do is in the table "What is not in the repo" in `README.md`.

## 5. The mistake loop

### Problem

An agent makes a mistake, the operator corrects it, the agent says "you are right" and a week later does the same thing. A
fix written only into memory or into the conversation does not survive. A fix that does not change the file that governs
behaviour is not a fix. And a request for more caution does not block the mistake.

When nobody records mistakes, you cannot see which ones repeat. A repeated mistake is a signal that a rule or a check is
missing, and without a record you will not catch it.

### When you need it

You need it when the same mistake returns a second time, even though the agent acknowledged it once. You also need it when
you trust the agent's word and later find that it claimed what it did not verify.

You do not need it while the agent does one-off tasks and mistakes have no consequence. Even then the first step of the
chapter helps, meaning the definition of a mistake in the rules. Add the script, the register and the hook only when you
have the first repeated mistake.

### Mechanism

The loop has five steps. The operator objects. The agent verifies the objection and accepts it. It fixes the file that
governs the behaviour and commits. It records the mistake in the register with a script. It introduces a check that blocks
the mistake, at the latest at the second occurrence of the class. The class of a mistake is a short key for one cause, for
example `neoverene-tvrdenie` (unverified claim). The same cause is the same class even in another concrete case.

These count as a mistake: a false claim, a step that was not the agent's, a needless action by the operator, an accepted
objection, a fix asked for twice, or damage to a live system. Every mistake of an agent is a process mistake. The agent
finds the tool, rule or check that let it through and fixes them before it declares the mistake handled.

The fix belongs in the file that governs the behaviour, meaning the persona, a rule, a skill, a hook or a check. A memory
entry is not a fix. A rule is written as the target behaviour with a check that can be ticked off, and for a ban with a
forbidden sentence. The persona carries a short line about the incident. Names from the incident belong in a decision
record, not in a role rule.

The strongest fix is a check that fails on the mistake. It is a test, a hook or a script. Before declaring the fix, the
mistake is replayed and the check is shown failing. A replay never touches a live system, and it first verifies that it
cannot fall back to a live path, mailbox or service. After a change of a value, option or path, the agent finds the old
value with `grep -rn` and fixes every hit, also in documents and comments.

The mechanical part is done by [bin/chyba.sh](https://github.com/gavalierm/agent-runtime/blob/main/bin/chyba.sh). It takes the class of the mistake and the file that governs the behaviour,
and does four things.

1. It rejects a file that is not committed, so the report carries the number of the fixing commit.
2. It writes a line into the register (date, agent, class, file, commit, description, task number).
3. At the second occurrence of the same class for the same agent, it creates in the task manager a task for a check that
   blocks the mistake.
4. It prints a report in four sentences. What I claimed or did, what was true, which file and commit changed, what stops it
   next time.

The agent puts the report into its next reply to the operator, even if not asked.

A hook that runs before the end of a reply (Stop) enforces the loop. It reads the last reply and the commands of the turn.
When the reply acknowledges a mistake (phrases like "you are right" or "my mistake") and `chyba.sh` did not run in the
turn, it stops the reply. It also stops it when the turn lacks a commit of the file that governs the agent, or when the
reply does not carry a commit number. On the second stop in a row it stays silent, so it does not loop.

The agent manager also follows a six-step improvement procedure.

1. Find the file and line that was missing or lying.
2. Name one cause in the system.
3. Write a fix with a check.
4. Deploy it.
5. Replay the scenario in which the problem arose.
6. Record the decision.

A fix of the type "I wrote it into a skill" is not approved.

### How to build it

1. In the global rules write a section on mistakes. Define a mistake, say that it is a process mistake, that the fix goes
   into a file that governs behaviour and that the check must fail on the mistake.
2. In the persona add a section "Own mistake" ("Vlastná chyba") that refers to the global rule and carries short lines about
   incidents.
3. Write [bin/chyba.sh](https://github.com/gavalierm/agent-runtime/blob/main/bin/chyba.sh) with the options `--trieda` (class), `--subor` (file), `--popis` (description), `--pravda` (what was
   true), `--kontrola` (check). The register is a file with tabs outside the repo, for example
   `~/.local/state/<name>/chyby.tsv`. The script finds the commit with `git log -1 --format=%h -- <file>` and rejects a file
   with unsaved changes (`git status --porcelain -- <file>` is not empty).
4. Write a skill `chyba` that says when to run the script and in what order. A skill is a file `SKILL.md` with a description
   by which the agent selects it.
5. Write a Stop hook that stops a reply that acknowledges a mistake without a commit and without the script. The hook does
   this.
   1. It takes `transcript_path` and `stop_hook_active` from the JSON on input. If `stop_hook_active` is true, it exits
      without output.
   2. It reads the transcript (one JSON per line) and finds the last message of the operator, meaning a `user` record that
      carries text.
   3. From the `assistant` records after it, it collects the reply texts and the commands of the Bash tool.
   4. If the text contains a phrase from the regular expression of acknowledgement and `chyba.sh` is not among the
      commands, it prints `{"decision":"block","reason":"<reason> Correct procedure: <step>"}`.
6. Write a hook test with a conversation transcript from a real mistake. The test must fail when you turn the hook off.
7. Give the task for the check at the second occurrence to the agent that manages the rules (chapter 7).

Running it (the script is in the agent-runtime repo, in a clone next to your repo):

```
bin/chyba.sh --trieda neoverene-tvrdenie --subor PERSONA.md \
  --popis "I claimed a state without checking" --pravda "the state was different" \
  --kontrola "the hook rejects a reply without proof"
```

### What it requires from the runtime

- A hook that runs before the end of a reply and can stop the reply with a reason that the agent gets back.
- Access of the hook to the session transcript, so it sees the reply text and the commands of the turn. In Claude Code it is
  the path in the field `transcript_path`.
- A flag that the hook already stopped once (`stop_hook_active`), so the loop does not repeat forever.
- For the automatic creation of a task for the check, a task manager with a command line (chapter 7). Without it the script
  does not create the task and says so.

### Our example

The mistake rules are in `global/CLAUDE.md`, §4, the accepted objection in §1. The script is [bin/chyba.sh](https://github.com/gavalierm/agent-runtime/blob/main/bin/chyba.sh), the skill
`skills/chyba/SKILL.md`, the hook [hooks/objection_fix.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/objection_fix.mjs), the tests [test/chyba.test.mjs](https://github.com/gavalierm/agent-runtime/blob/main/test/chyba.test.mjs) and
[test/objection_fix.test.mjs](https://github.com/gavalierm/agent-runtime/blob/main/test/objection_fix.test.mjs). The decision on the loop is `rozhodnutia/D0142.md`, a private record that is not in the repo
(its content is in the table "What is not in the repo" in `README.md`). The improvement procedure is in
`roles/spravca-agentov.md`, part "Improving agents" ("Zlepšovanie agentov"). The section "Own mistake" is shown by
`PERSONA.md` in the agent manager's repo.

## 6. Hooks as enforcement

### Problem

A rule written in a sentence is followed by the model most of the time, not always. The longer the context, the greater the
chance it forgets. The operator cannot read every reply. What a machine can check should be checked by a machine.

A rejection without an explanation is another problem. The model guesses afterwards, and every attempt costs a call with the
whole context.

### When you need it

You need it for a rule that the agent broke at least twice, and for a step whose consequence cannot be undone (a write into
the register outside the script, a dangerous git command, a reply with a link that does not work). Do not write a hook for a
rule the agent follows. Every hook adds code that must be maintained, and it slows a turn slightly.

You do not need it at the start. Begin with a rule in a sentence, and when the agent breaks it, write a hook for that one
mistake.

### Mechanism

A hook is a script that the runtime runs on an event. It gets JSON on standard input (for example `session_id`, `cwd`,
`transcript_path`, `tool_input`) and returns the result through output or an exit code. In Claude Code this holds.

- Code 0 says the hook ran. The output of SessionStart and UserPromptSubmit is added to the agent's context.
- Code 2 blocks the step, and the agent gets the text from standard error.
- Any other code is a hook error. The step continues and the agent does not know about the error.
- The hook can print JSON instead. Rejecting a tool (PreToolUse) is
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`.
  Stopping a reply (Stop) is `{"decision":"block","reason":"..."}`.

The events we use:

| event | when it runs | what it enforces for us |
|---|---|---|
| SessionStart | start, resume, `/clear`, compaction | `unslop.mjs` inserts the core of the writing rules, `identity.mjs` announces the identity and inserts the roles, `clear_bridge.mjs` performs the session start after `/clear`, `rozhodnutia_context.mjs` inserts changes of decisions |
| UserPromptSubmit | on every prompt | `context_warning.mjs` warns about the context limit, `rules_delta.mjs` inserts a change of rules, `tasker_work.mjs` announces work on a task |
| PreToolUse | before a tool is used | `no_model_wait.mjs` rejects a wait in the foreground, `foreign_git.mjs` and `git_pull.mjs` dangerous git, `tasker_root.mjs` a direct task manager command under root, `web_review.mjs` a web task without a review, `rozhodnutia_guard.mjs` a write of a decision outside the script, `own_rule_scope.mjs` a rule at the wrong level |
| SubagentStop | end of a sub-agent | `tasker_work.mjs` ends the work record |
| Stop | before the end of a reply | `reply_guard.mjs` the cap and links in the reply, `todo_after_comment.mjs` a task after a comment, `objection_fix.mjs` an acknowledged mistake without a fix |

Every rejection carries a correct procedure. The principle rests on one helper module through which all hooks reject. The
module prints the reason and the line "Correct procedure: <step>" (our files use "Správny postup:"), and it refuses an empty
procedure and vague sentences like "try differently". So the agent does not have to guess and saves a call that would cost
the whole context. A guard runs in the repo check and fails on a hook that rejects with raw JSON, with code 2 or with `echo`
to standard error without a procedure. The rule in the instructions that the hook guards then needs only a short sentence
with the name of the hook.

Three principles for your own hook.

- A Stop hook is silent on the second stop in a row (`stop_hook_active`), otherwise it loops.
- A hook that only announces never blocks a tool, and on error it stays silent with code 0.
- A hook that keeps state in a file stores it per session, so sessions do not affect each other.

Every hook has a test next to it. The mistake because of which the hook arose is in the test as a replay, meaning the input
that caused the mistake, run again. A test never touches a live database or service. Hooks that read the state of the task
manager read the database read-only.

The wiring is in `settings.json`, either in the environment settings or in `.claude/settings.json` of the agent's repo. The
installer first removes the hook groups from our path and then adds the current ones, so it can be run repeatedly and an old
clone does not stay wired.

### How to build it

1. Write a helper module for rejection with three functions. The first rejects a tool (PreToolUse), the second stops a reply
   (Stop) and the third rejects with code 2. All take a reason and a procedure and refuse an empty procedure.
2. Write a check that fails on a hook with a raw rejection. It is enough to scan the hook files and find
   `permissionDecision` or `process.exit(2)` outside the helper module.
3. Start with one Stop hook that guards one thing that already went wrong for you.
4. For every new hook write a test with a replay of the mistake and add it to the repo check.
5. Wire the hook in `settings.json` with a repeatable script.

The smallest hook that rejects a wait in the foreground:

```
#!/usr/bin/env node
import { readFileSync } from "node:fs";

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
const cmd = input.tool_input?.command ?? "";
const m = cmd.match(/\bsleep\s+(\d+)/);
if (m && Number(m[1]) > 10) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "A wait in the foreground keeps the turn open and you pay for it.\nCorrect procedure: end the reply and handle the result in the next turn.",
    },
  }));
}
```

Wiring:

```
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node <agent-runtime clone>/hooks/reply_guard.mjs" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [ { "type": "command", "command": "node <rules clone>/hooks/no_model_wait.mjs" } ] }
    ]
  }
}
```

### What it requires from the runtime

- Hooks on the events from the table, which get JSON on input and can add text to the context, reject a tool or stop a
  reply. Claude Code does this and describes the formats in the hook documentation.
- Wiring in a settings file that the runtime reads at start. In Claude Code a change of settings takes effect in a new
  session, not always in a running one.
- Node.js or another interpreter in which you write the hook. A hook can also be a shell script, if it reads the input with
  a JSON tool.

### Our example

The hooks are in the `hooks/` folder of the agent-runtime repo and their tests in its `test/` folder, not in this repo. The rejection helper is [lib/deny.mjs](https://github.com/gavalierm/agent-runtime/blob/main/lib/deny.mjs) (for git hooks
[lib/deny.sh](https://github.com/gavalierm/agent-runtime/blob/main/lib/deny.sh)), the guard is [lib/deny_check.mjs](https://github.com/gavalierm/agent-runtime/blob/main/lib/deny_check.mjs), the decision is `rozhodnutia/D0141.md`. The wiring is done by the function
`settings` in `env/server/install.sh`, which are not in the repo (see the table "What is not in the repo" in `README.md`).
The header comments of [hooks/reply_guard.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/reply_guard.mjs), [hooks/objection_fix.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/objection_fix.mjs), [hooks/todo_after_comment.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/todo_after_comment.mjs) and
[hooks/tasker_work.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/tasker_work.mjs) describe what the hook enforces and what triggered it.

## 7. Work is a task in a task manager

### Problem

Work assigned in a conversation has no reason, no done condition and no state. Nobody knows whether it stands, waits or is
done. An open task that nobody works on gets lost. A question to a human in a conversation gets lost too, because it does not
show up where the human looks for it.

### When you need it

You need it when an agent does several things at once, when work takes longer than one session, or when several agents work
on it. You also need it when the operator asks "what is stuck and why".

You do not need it with one agent and one task that one session finishes. A conversation is enough then. A task file in the
project repo is also enough at the start (part "How to build it"). Add the hooks from the end of the chapter only when you
have a tool that a machine can read.

### Mechanism

Regular work for an agent is a task in a task manager (in our case Tasker). The task manager is a tool with a database of
tasks, a command line and a web. Every task has a project, a reason, a done condition and an assignee. The assignee is the
agent or human who does it. The done condition is a note by which you can decide whether the task is done, best a command and
its expected output. A task without a project is rejected. A task without an assignee wakes nobody when its blockers finish,
so a task the agent does itself or through a sub-agent is created with an assignee.

The states that the rules and hooks use:

| state | meaning |
|---|---|
| `todo` | waits to be taken |
| `in_progress` | somebody works on it |
| `needs_human` | the agent asks a human or waits for approval |
| `blocked` | stands on another task |
| `waiting` | waits for an event outside the task manager |
| `done`, `cancelled`, `failed` | end |

A question to a human is a state of the task, not a sentence in a conversation. The agent writes the question into a
comment, sets `needs_human` and ends the run. The human's answer is a comment that wakes the task. When the answer arrives in
a thread instead of a comment, the agent first writes it into the task as a comment under the operator's name and only then
acts. Otherwise the task manager does not know about the answer and the task stands.

Waiting has two forms, and both have a reason. Waiting for another task is a blocker, a link "this task stands on that one",
with a mandatory reason that says what the blocker stands on, who will remove it and what moves the task afterwards. Waiting
for an event outside the task manager is the state `waiting` with a reason and a time, and after the event the task is closed
or resumed. Bare blocker numbers do not tell the reader what the task stands on.

A fix to work on a closed task goes into a new task, because a comment on a closed task wakes nobody.

A task with several steps follows a four-step procedure.

1. Unclear request. The agent writes at most five questions whose answer it cannot find in the code or in the task, and ends
   in the state `needs_human`. With more questions it proposes to split the task.
2. Plan. The agent writes into a comment a plan with four parts. What we do (two to four sentences), steps (at most seven),
   what we do not do (never empty) and how we verify that it works (one to three tests). The plan does not go into a file in
   the repo. Approval is a comment. The operator's deputy approves the plan, and the operator approves a reserved matter.
3. Build. A step that does not fit into one run is a subtask chained with blockers. The agent does not do work outside the
   plan. It proposes a change of plan in a comment and ends in the state `needs_human`.
4. Check. Before closing, the agent writes a comment with three answers with proof. Does it work (a command and its output)?
   Does it match the plan (what is missing, what was added, what else the change touches)? Is it simple (what could be
   deleted)? If an answer does not hold, the result is `needs_human` with a reason.

The agent manager is responsible for the flow of work. An open task that nobody works on is its mistake. It watches a blocker
assigned to a human, and when nobody takes it within 30 minutes, it sends the operator a notification with the task number and
what exactly stands. The sentence "waiting for the operator" without a time and without a notification is forbidden.

Hooks keep the task manager and the turn consistent. The hook `todo_after_comment.mjs` stops a turn in which the agent wrote
a comment on its task and the task stayed in the state `todo`, and gives a procedure (close, wait, block or ask a question).
The hook `tasker_work.mjs` announces the work of a sub-agent from the task number in its assignment. The hook
`tasker_root.mjs` rejects a direct task manager command under root and sends the agent to the wrapper `bin/tk`. The wrapper
is a small script that runs the task manager command under the right user and with the agent's name in the environment. A
task number in a text for the operator is a link to its page, and the hook `reply_guard.mjs` stops an unlinked mention and
gives a ready replacement.

### How to build it

1. Pick a task manager with a command line. If you have none, start with a task file in the project repo, for example
   `ulohy/0042.md`. The file has a header between two `---` lines with the fields `id`, `nazov`, `projekt`, `stav`,
   `riesitel`, `dovod`, `hotovo` and `blokery` (a list of task numbers), and below it comments, each line with a date and a
   name. Both a hook and a human can read such a file. Add the hooks of this chapter only when you have a tool that a machine
   can read.
2. Fix the states from the table and the duty to give a reason for a blocker and for waiting. The command looks like
   `tasker block <id> --by <id> --reason "<reason>"` and fails without a reason. If you use files, the repo check rejects
   `stav: blocked` without a non-empty comment about the cause.
3. In the environment rules write that work is a task with a project, a reason and a done condition.
4. Write the four-step procedure into the environment and use it first on one project.
5. Introduce the rule that an answer of the operator in a thread is first written into the task.
6. Write a Stop hook that stops a turn after which the agent's commented task stayed in the state `todo`. The hook finds tasks
   where the assignee is the agent, the state is `todo` and the last comment was written by the agent after the last message
   of the operator. Read the state from the task manager database read-only, or from files.
7. In the role of the agent manager write that an open task without work is its mistake, and the 30-minute limit for a blocker
   assigned to a human.
8. Decide how a task reaches the agent. When somebody assigns a task to the agent or adds a comment, the assignee must find
   out. Write a small bridge that watches the events of the task manager and writes a message to the assignee's mailbox
   (chapter 8).

### What it requires from the runtime

- A task manager that can be operated from the command line, so the agent uses it with a command tool. A web interface is not
  enough.
- A task state that a machine can read for the hooks. Best a database or files that the hook opens read-only.
- A way for the assignee to learn about a change (chapter 8), otherwise tasks stand until the agent looks on its own.
- A PreToolUse hook for the tools that start a sub-agent, if you want to announce the work of sub-agents. The hook input
  carries the sub-agent's assignment, from which the hook extracts the task number.

### Our example

The rules are in `env/server/CLAUDE.md`, parts "Task manager" ("Správca úloh") and "Task procedure" ("Postup úlohy"). The
deputy approves the plan according to `roles/zastupca-operatora.md`. The flow of work and the 30 minutes for a blocker are in
`roles/spravca-agentov.md`, part "What it manages and the flow of work" ("Čo spravuje a tok práce"). The hooks are
[hooks/todo_after_comment.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/todo_after_comment.mjs) and [hooks/tasker_work.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/tasker_work.mjs). The wrapper is `bin/tk`. The hook `hooks/tasker_root.mjs`, the
script `bin/uloha-webu.sh` (creates a task for a web agent together with a task for a designer's review) and the hook
`hooks/web_review.mjs` (rejects everything else) are tied to our task manager and are not in the repo, and the table "What is
not in the repo" in `README.md` describes them. The task manager itself is not in this repo, it is a separate tool. The
bridge that delivers task events into mailboxes is in the repo `https://github.com/gavalierm/agent-runtime` (public, D0171).

## 8. Messages between agents

### Problem

You have two agents in persistent sessions, and the first needs a result from the second, for example a deployment to a test
machine. The operator should not be a postman who copies messages from one window to another. When the first agent writes
text straight into the input of the second, it interrupts the second one's running work or gets in the way of what a human is
typing right now. When it waits for the reply in a loop, the turn stays open and you pay for every further reading of the
context. And when you do not agree on who waits for whom, one side waits for nothing and the other does not know that
somebody expects it.

### When you need it

You do not need it when you have one agent. You do not need it either when agents write to each other with comments in the
task manager (chapter 7) and that is enough, because a comment wakes the assignee and the task carries the state.

You need it with two or more agents in persistent sessions who send each other orders and results outside tasks. That means
an urgent matter that cannot wait for a task, a question on which the sender is blocked, and a handover of state between
machines.

Why files in a directory and not a queue or a database. You need no service that can fail, and nothing gets installed. You
read a message with `ls` and `cat` and fix it with an editor. A rename with `mv` on one disk is atomic, so the addressee
never sees a half-written file. A file survives a restart of the process and of the machine, and a message in an in-memory
queue does not. A queue or a database pays off at hundreds of messages a second. For us it is tens, up to about a hundred
messages a day in the mailbox of one agent.

### Mechanism

Every agent has a mailbox, a directory with the subdirectories `inbox` and `processed`. A message is a file in the
addressee's `inbox`. Writing goes through a hidden temporary file and `mv`, so the addressee never reads a half-written file.
The file name has the form `<sender>-[<topic>-]<YYYYMMDD-HHMMSS>-<pid>.md`.

The waker is a program that delivers a message from the mailbox into the running session of the agent and moves the file to
`processed`. It runs continuously next to the agents and does not call a model. It never sends a message into a running run.
It sends the messages that wake in one batch after a short quiet window, so messages that arrive close together go in one
turn.

Every message the waker sends is one model turn, and that turn reads the whole context again. A measurement on 19 Oct 2026
showed that 36 of 69 turns had no action. So the first line of a message says what the sender expects of it (the message
mode), and scripts write it, not the model. The header keys and mode values in this chapter are written as our scripts write
them, in Slovak, with the meaning in parentheses. If you build your own, use your own words.

| first line | means | waker of the addressee | reply to it |
|---|---|---|---|
| `odpoveď: čakám` (reply: I wait) | an order or a question, the sender is blocked on the reply | wakes | mandatory, wakes the sender |
| `odpoveď: nečakám` (reply: I do not wait) | a tool message or a summary, the result is read at the next turn | wakes | goes without waking |
| `odpoveď: na vedomie` (reply: for information) | a report, a result, a confirmation | does not wake, holds until the next batch | is not written |

A message `na vedomie` wakes only as a reply to a message the sender waits on. So a reply `na vedomie` to a message `čakám`
wakes the sender, and a reply `na vedomie` to a message `nečakám` does not.

The send script writes a new message as `čakám`, with the option `--vedomie` as `na vedomie`, and has no other mode. The reply
script writes `na vedomie` by default, and when it needs something back, it has `--cakam` or `--necakam`. A reply `na vedomie`
to a message `nečakám` does not wake the sender, so the send script rejects the mode `nečakám` for a new message. A message
`na vedomie` is not answered, and the confirmation "received" is not sent. Work that arises from it is a new order.

A reply is paired with the original message by the header `k:` (to), so the file name can be anything. The agent also writes
from a topic thread (a thread is a persistent session of the agent in its tool, a topic thread is another thread of the same
agent that runs one topic). So after the write the script stores a reply route, meaning the message key and the sender's
thread, and the waker uses it to deliver the reply to the topic thread, not to the main one.

A message to an agent is a work order. An order carries the task, the context the addressee lacks, and the done condition. A
reply carries the result, the proof (a command and its output) and what is open. A path, a line or a commit replaces a copy.
Uncertainty is written with the word "unverified". No greetings, thanks, apologies or restating.

Why not shared memory. Deputies on different machines pass state through mailboxes, not through shared memory. A message in a
mailbox has a sender, an addressee, a topic and an expected reply. An entry in shared memory carries none of that, so nobody
knows who should act on it or who is waiting.

### How to build it

When you do not need mailboxes (part "When you need it"), skip the whole chapter. Otherwise proceed in this order.

#### 1. Directories and permissions

For each agent create `<root>/<agent>/inbox` and `<root>/<agent>/processed`. The directory `inbox` has the mode `2770`
(setgid) and a shared group that contains the agents who write into it and the user of the waker. An agent name is lower case
letters, digits and underscore, at most 31 characters, starting with a letter. For us there is also an `outbox` next to the
agent, from the time when replies were read from it. If you build from scratch, you do not need it, a reply is an ordinary
message into the `inbox` of the original sender.

An agent on another machine has no mailbox on its own disk. The mailbox is on the machine where the waker runs, and a sender
from the second machine writes the file over `ssh` with the same procedure (hidden `.tmp`, then `mv`).

#### 2. Message format

The header is lines at the start of the file, then the text of the message. The first line is always `odpoveď:`. A message
without it is delivered as waking, so that hand-written messages can be delivered too.

```
odpoveď: <čakám|nečakám|na vedomie>
k správe: <mode of the original message>      (reply only, second line)
id: <file name>
od: <sender>
komu: <addressee>
téma: <topic, empty for the main thread>
k: <id of the original message>                (reply only)
```

The line `id:` is the file name. The line `k správe:` (to message) is copied by the reply script from the first line of the original
message, and the waker uses it to decide whether a reply `na vedomie` should wake. The waker removes the header from the text
for the model and puts it into a tag (point 5). The file name must match the pattern
`^[a-z][a-z0-9_]{0,30}-[A-Za-z0-9._-]{1,120}$`, and the waker skips other files in `inbox`. It also skips files whose name
starts with a dot or ends with `.tmp`, those are writes in progress.

An example message:

```
odpoveď: čakám
id: agent_a-deploy-20261024-101500-4242.md
od: agent_a
komu: agent_b
téma: deploy

Task. Deploy version 3 to the test machine.
Context. The version is in the tag v3. Do not change the database.
Done when `curl -sI https://test.example/` returns 200.
```

An example reply that agent B writes after the deployment:

```
odpoveď: na vedomie
k správe: čakám
id: agent_a-deploy-20261024-101500-4242.md
od: agent_b
komu: agent_a
téma: deploy
k: agent_a-deploy-20261024-101500-4242.md

Done. `curl -sI https://test.example/` returns `HTTP/2 200`. Open: nothing.
```

#### 3. The send script

Usage: `ask_agent.sh [--vedomie] [--k <id>] <addressee> <topic> < message.md`. The script takes these steps.

1. It verifies that the addressee and the sender have the form of an agent name and that the addressee's `inbox` exists.
   Otherwise it exits with code 1 and writes nothing. The sender is an environment variable with the agent's name.
2. It rejects an empty message.
3. It rejects the option `--necakam` with a message that you wait for the reply and should leave the default, or that a
   report without a reply is `--vedomie`. The reason is in the table above, a reply `na vedomie` to `nečakám` does not wake
   the sender, who would wait for nothing.
4. It builds the name `<sender>-[<topic>-]<time>-<pid>.md` and the header. The mode is `čakám`, with `--vedomie` it is
   `na vedomie`.
5. It sets `umask 007`, writes `.<name>.tmp`, sets its group to that of the `inbox` if the directory does not inherit it, and
   does `mv` to the final name.
6. It stores the route (point 7) and prints the message id.

Optionally, for a new message the script verifies that the topic is in the addressee's list of topics (a file next to its
`inbox`), and for an unknown topic it prints the valid topics and sends nothing. You do not need that at the start.

#### 4. The reply script

Usage: `reply.sh [--cakam|--necakam|--vedomie] <message id> < reply.md`. The agent calls it with the command that the waker
prints in the message tag.

1. It verifies the form of the id and rejects an empty reply.
2. The default mode is `na vedomie`. When the body of the reply contains a line starting with `Úloha` (Task), `Otázka`
   (Question) or `Hotovo:` (Done:), and the mode is not chosen explicitly, the script rejects the write. Such a body is an
   order, and a reply `na vedomie` would wake nobody.
3. It finds the original message in `processed` (the waker has already moved it there), and takes its first line for
   `k správe:` and the topic.
4. It builds the header with `k: <id of the original message>`, `od:` is the replying agent, `komu:` is the sender of the
   original message.
5. It writes the file into the `inbox` of the sender of the original message the same way as the send script (`.tmp`, `mv`),
   under the name `<from>-[<topic>-]<time>-<pid>.md`. For us the reply has a name made from the prefixes of both sides and
   the core of the original name. You do not need that for your build, the reply is paired by `k:`.
6. It stores the route (point 7).

#### 5. What your runtime must be able to do, and how we do it

The waker needs two things. It must know whether the agent is working in the thread right now, and it must be able to send
text into its session without interrupting a running run. If your tool cannot do either, it is enough that the agent looks at
`inbox` at the start of every turn, but then a message does not wake the agent. We have not tried that form.

For us agents run as persistent threads in T3 Code, and the waker does this.

1. It reads the thread state from the HTTP list of threads of the server. A thread row carries the id of the active run, the
   run state, a flag of waiting for approval and the thread state. A thread is busy when it has an active run, when it waits
   for approval by a human, when its state is not final (an idle thread, a completed, interrupted, failed or cancelled run) or
   when it ended with a subscription limit error and the renewal time has not come yet.
2. It sends the text with the command `message.dispatch` over a WebSocket. T3 Code 0.1.0 has no HTTP call for a message into a
   thread, so the waker requests a one-time ticket, opens a WebSocket and sends the command. The command carries the delivery
   mode `queue_after_active`, meaning queue after the active run. If a run started between reading the state and sending (for
   example a human wrote into the thread), the message queues behind it and interrupts nothing.
3. The command also carries a `commandId`, which the waker derives from the file names of the batch, the attempt number and a
   random batch id. The server remembers the receipt of every `commandId`, so a repeat after a crash of the waker does not
   create a second message.
4. As a fallback, text can be sent to a CLI client in `tmux` with `tmux send-keys -l` and Enter as a separate step. `tmux` does
   not know the run state and cannot tell whether the agent is typing, so it is only a backup.

For your runtime this means two requirements. You need a way to find out that a session is not working right now, and a way
to put input into it so that it queues behind running work, or at least so that the waker waits for its end. If the runtime
has no idempotent commands like `commandId`, a crash between sending and moving the file can deliver a message twice. So move
the file to `processed` right after a successful send.

#### 6. The waker

The waker is a loop. One pass does this.

1. It reads `inbox` (files with a valid name, without a leading dot and without `.tmp`) and sorts them by modification time.
   An empty `inbox` ends the pass.
2. For each message it finds the target thread and whether it wakes. A message with `odpoveď: čakám` or `nečakám` and a
   message without the line wake. A message `na vedomie` wakes only when it has `k:` to a message that the sender sent as
   `čakám`, or the line `k správe: čakám`. Otherwise it is held.
3. The target thread is the thread from the reply route (point 7). A message without `k:` or without a route goes to the main
   thread of the agent.
4. Quiet window. The batch for a thread goes out when `AGENT_BATCH_WAIT_S` (30 s for us) has passed since the last waking
   message, or `AGENT_BATCH_MAX_WAIT_S` (120 s) since the first waking message. The batch is everything that wakes, and it
   goes out as one message, so messages that arrive close together use one turn. The value `0` turns the window off.
5. It checks whether the thread is working (point 5). If so, it sends nothing and tries again after the next interval.
6. It builds the batch text. At most 20 waking messages, each up to 100 kB, and at most 10 held messages `na vedomie`, each
   up to 4 kB, under the heading "For information" ("Na vedomie"). Each message is in a tag:

   ```
   <schranka od="agent_a" tema="deploy" id="agent_a-deploy-20261024-101500-4242.md" odpoveď="čakám">
   odpoveď: reply.sh <id> <<'EOF' ... EOF (the sender waits for it)

   Task. Deploy version 3 to the test machine.
   </schranka>
   ```

   For messages `na vedomie` the reply line is "a reply is not written".
7. It writes the batch to a state file (a list of files, the attempt number, the batch id), sends it and, after receipt, moves
   the files to `processed`. If a file with the same name is already there, it appends the time to the name. Then it deletes
   the state. If the server rejects the batch, it raises the attempt number, so the rejected `commandId` is not repeated.
8. It sleeps `POLL_S` (5 s for us). On a connection error it waits twice as long, at most 300 s.

A held message `na vedomie` stays in `inbox`, nothing is deleted. It goes out under the heading with the next waking batch to
the same thread. The morning summary moves a message `na vedomie` older than 24 hours to `processed` and prints it.

#### 7. The reply route

The route solves the problem that an agent writes from a topic thread and the reply must come back there, not to the main
thread.

1. When writing a message (and a reply), the script finds the thread the agent writes from. It uses the session id that the
   agent process has in its environment (for us `CLAUDE_CODE_SESSION_ID`) and that the tool lists with the thread. After a
   clean context the process has a new session, so the id is also searched in the argument `--resume` of the process command
   line.
2. If the thread is not the main one, it writes into the file `routes.json` in the waker's state a record with the message key
   (the name without the prefixes of both sides), the other side and the thread. A record older than 30 days drops out. For
   the main thread no record is written, and an older one with the same key is deleted.
3. For a message with `k:`, the waker finds the record by `k:`. If the thread exists and is not archived, the message goes
   there. Otherwise it goes to the main thread with the line `[budič] Správa patrí vláknu <id>, to je archivované, preto je tu.`
   (waker: the message belongs to thread <id>, which is archived, so it is here).
4. If the script does not find the thread, the message goes out without a route and the reply comes to the main thread. The
   script prints that.

Our version can also deliver a new message about a topic to the topic thread, using the list of topics. You do not need that
at the start.

#### 8. Rules for the agent and a hook

Write a rule that after sending a message `čakám` the agent ends the turn and does not wait for the reply, the waker will
deliver it. Add a PreToolUse hook that rejects a command with `sleep` over ten seconds or a loop with `sleep` in the
foreground. The rejection carries the line "Correct procedure:" (chapter 6).

### Our example

The mailbox rules are in `env/server/CLAUDE.md`, part "Mailboxes and the waker" ("Schránky a budič"). The send script, the
reply script, the waker and the routes are in our runtime, which is not in this repo. It lives in the repo
`https://github.com/gavalierm/agent-runtime` (public, D0171). The chapter still describes it in a way that does not make you depend on the link. The scripts are also described by the table "What is
not in the repo" in `README.md`, including what you need from them to build your own. They are `bin/ask_agent.sh` (the send
script, test `hooks/ask_agent.test.mjs`), `runtime/reply.sh` (the reply script), `runtime/driver.mjs` (the waker),
`runtime/route.mjs` (reply routes and the list of topics) and `runtime/README.md` (the runtime description, part "Waking"
("Budenie")). The hook against waiting, `hooks/no_model_wait.mjs`, is not in the repo. The rules for messages to agents are in
`global/CLAUDE.md`, §2.

## 9. Delegation

### Problem

A strong model that does everything itself is expensive and slow. A cheaper model without supervision makes a mistake that
nobody catches. A task assigned step by step ties the assigner to every detail. And work done by someone who has no rights
for it breaks the boundaries of jurisdiction.

### When you need it

You need it when you have at least two agents with different rights (one has root, the other does not), or when you pay for
models of different prices and want one fitting each piece of work. You also need it when a strong session spends tokens on
mechanical building that a cheaper model could handle.

You do not need it with one agent and one model. Then delegation has nobody to go to. You also do not need it for work that
you finish in a few calls. Handing work to a sub-agent costs writing the assignment and reading the result, which does not
pay off for small work.

### Mechanism

The work is done by the lowest level that has the rights for it. A stronger model designs and verifies, a cheaper one builds.
A session on the strongest model gives the implementation to a sub-agent on a cheaper model and keeps the design and the
verification for itself. A stronger sub-agent goes only for design, audit or work that failed with the cheaper one, and the
reason is written down. A sub-agent is a second session that the main session starts for one partial piece of work. It
returns to the main session only the result, not its whole conversation, so the main context stays small.

Before each task for an agent, the agent manager takes five steps.

1. It decides which rights the task needs, for example reading, writing in its own repo, root, a sensitive action or a
   decision.
2. It picks the lowest agent that the persona allows to do it.
3. It looks at the open tasks of the chosen agent. For an overloaded one it splits the task or hands it over through its
   superior.
4. It writes into the assignment why the task belongs to exactly this agent.
5. It hands a wait for an outside state to a script without a model, which wakes the agent only at a change.

The assignment states the goal and the done condition, not the steps. The agent does not check the intermediate state, it
verifies the result. The agent manager verifies finished work itself and does not rely on the agent's message. Access that
only the manager has (a token, an account) is no reason to do the agent's work. The manager issues the agent a narrow access
and assigns the work to it. Speed is not a reason either. The sentences "I assigned it to the server administrator" for a
task that needs no root and "I did it myself, it was faster" are forbidden.

A task carries a number, so it is visible who works on it. The assignment to a sub-agent contains the text "úloha N" (task N;
our hook matches the Slovak word). A hook before the sub-agent tool starts (PreToolUse for the tools Agent and Task) finds
the number and announces to the task manager that somebody works on the task. After the sub-agent ends (SubagentStop) it
closes the record. Without the number in the assignment, the task looks stalled. Before assigning a task to a sub-agent, the
agent looks at the latest work records on the task, so two do not work on it at once.

### How to build it

1. In the global rules write which model designs and verifies, which builds, and when it is allowed to go higher. In Claude
   Code you choose the sub-agent model in the call of the Agent tool with the parameter `model`.
2. In the role of the agent manager write the five steps of choosing an agent and the two forbidden sentences.
3. In the environment write that an assignment to a sub-agent carries "task N", and write a hook that finds the number. The
   hook does this.
   1. In PreToolUse for the tool `Agent` (and the old name `Task`) it finds the number after the word "úloha" (task) in
      `tool_input.prompt` with a regular expression.
   2. It announces the work with a task manager command and stores the pair of `tool_use_id` and the task number in the
      session state file.
   3. In SubagentStop it does not see the sub-agent's assignment, so it finds the record through the stored file. When no
      other sub-agent with the same task is left in the session, it closes the work record.
   4. On error or without a number it stays silent with code 0 and never blocks the tool.
4. Write a template of the assignment with the goal, the context the addressee lacks, and the done condition. The first line
   looks like `Task 120. Rename the variable X to Y in the scripts in bin/. Done when grep for X is empty.`
5. Turn a procedure assigned by hand a second time into a skill with a script. A skill is a file with a description of when
   to use it, and the script does every step that needs no judgement.

### What it requires from the runtime

- Starting a sub-agent from a session with a model choice. Claude Code provides it through the Agent tool with the parameter
  `model`.
- A hook before this tool starts and a hook after the sub-agent ends, whose input carries the assignment and the id.
- A task manager (chapter 7) into which you can record that somebody works on a task. Without it, the task number in the
  assignment is only a habit.
- For the split of rights, machines or users whose rights can be separated (root and the others), and a persona that
  describes the boundaries of jurisdiction.

### Our example

The rule on models and handing over work is in `global/CLAUDE.md`, §6. Delegation is in `roles/spravca-agentov.md`, part
"Delegation" ("Delegovanie"), and the instructions to agents in the part "Instructions to agents and fixing" ("Pokyny agentom
a oprava"). The hook [hooks/tasker_work.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/tasker_work.mjs) with the test [test/tasker_work.test.mjs](https://github.com/gavalierm/agent-runtime/blob/main/test/tasker_work.test.mjs) shows how the task number is found in
the assignment. Skills for repeated procedures are in `skills/`. Our `skills/projekt-novy` (creating a web project) is not in
the repo, it is tied to our accounts and domains.

## 10. Writing

### Problem

Model text has recognisable patterns. Long replies with an introduction, a summary, offers of more work, filler and bold
labels do not get read. The operator does not find what they need in them and stops reading them. A rule "write briefly"
without a check gets forgotten.

The second problem is a link that does not work. The agent sends the operator the address of a page that is not running yet,
or an address on `localhost`, which the operator cannot open on their device.

### When you need it

You need it when you read agent replies every day and they tire you. You also need it when agents write texts that other
people read (documents, commit messages, comments).

You do not need it for an agent that writes only code and short statuses. A rule on length in the global rules is enough
then. Add the hook with a cap only when the agent breaks the rule at least twice.

### Mechanism

The writing rules have one source, the skill `unslop`. It applies to every text meant for a human, that is replies,
documents, commit messages, code comments and decision records. A message to another agent follows the message rules
(chapter 8), not the readability rules. The operator ranks `unslop` above the other skills.

The core of the skill is one paragraph. Short whole sentences with a verb, active voice, plain words, concrete names, numbers
and mechanisms instead of impressions. No dashes, typographic quotation marks, emoji or bold labels with a colon. No filler
and inflated words, no forced triplets and no chatbot phrases. Before handing over, the agent asks what in the text gives
away AI, and fixes it. The rest of the skill is a catalogue of patterns with fixed rule numbers, so other skills can refer to
a rule by number.

A SessionStart hook inserts only the core into the context, at start, after `/clear`, on resume and after compaction. The
whole catalogue would cost thousands of tokens at every start, and the core costs a few hundred. Claude Code inserts at most
10 000 characters from one hook. If the core is longer than the limit of inserted context allows, the hook reports it and
exits with code 1, so the repo check catches it before deployment. The first reply of a session announces the line
`unslop: načítané, hook, verzia <verzia>` (loaded, hook, version), so the operator sees that the core arrived. The version is
the first eight characters of the checksum of the skill file, which the operator can compare with `shasum -a 256`.

The length of a reply has a cap. A reply to the operator has one to three sentences, namely the verdict, the reason and what
to do. It is longer only when the operator asks for steps, details or a document. A hook at the end of a reply (Stop) stops
the reply when it has more than six sentences of prose, a sentence over 35 words, a list item with more than one sentence, a
link that does not answer today, or a link to localhost. Code blocks, tables, headings and the lines "Waiting for you:" do not
count as prose. The first line of the reply of an agent with a persona is only its name and a colon, the second is empty.

Details go into a file. The agent saves a file for the operator (a page, a document) in the working directory outside the
temporary directory, for example `docs/`, and gives its path in the reply. The runtime turns the path into a link that the
operator opens. The sentence "the file is on the server, you cannot open it" is forbidden.

A plan goes for approval only with verified claims. A Stop hook stops a reply that offers a plan and postpones the
verification until deployment.

### How to build it

1. Write the skill `skills/unslop/SKILL.md` with the core at the start. The file begins with a header with `name` and
   `description`, then the heading `## Jadro` (Core) and under it the paragraph of the core. Describe the forbidden patterns
   concretely and give examples in the language you write in.
2. Write a SessionStart hook that inserts only the section "Core". The hook does this.
   1. It reads `SKILL.md` and extracts the text between the heading `## Jadro` and the next heading `## `.
   2. It computes the checksum of the file and takes the first eight characters as the version.
   3. It prints the core and a version line to standard output. At SessionStart the output is added to the context.
   4. If the text is longer than 10 000 characters, it prints an error to standard error and exits with code 1.
3. In the global rules write a section on writing with a link to the skill and the reply cap.
4. Write a Stop hook with a cap on sentences and words. The hook does this.
   1. It takes the agent's last reply from the session transcript.
   2. It removes code blocks, headings, tables and the lines that do not count as prose.
   3. It splits the rest into sentences and counts them. It stops the reply when there are more than six sentences or a
      sentence has more than 35 words.
   4. It finds `http` and `https` addresses, sends a `HEAD` request to each, and stops the reply when one does not answer or
      is `localhost`.
   5. On the second stop in a row (`stop_hook_active`) it stays silent.
   Start with one cap and add checks when you run into the next problem.
5. Introduce a directory for the operator's documents and the rule "a reply carries the path, not the content".

### What it requires from the runtime

- A hook at session start whose output is inserted into the context also after clean context, resume and compaction.
- A hook at the end of a reply that gets the text of the last reply (in Claude Code through the session transcript) and can
  stop it.
- A way for a file in the working directory to reach the operator, for example a link made from a path in the interface they
  use. If the runtime has none, send the file another way and the reply stays short.
- A network for the link check. Where you have none, turn the link check off (for us the variable `REPLY_GUARD_NO_NET=1`).

### Our example

The skill is `skills/unslop/SKILL.md`, the core is its section "Core" ("Jadro"). `hooks/unslop.mjs` inserts it into the
context. It is not in the repo, you write your own. The reply cap is held by [hooks/reply_guard.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/reply_guard.mjs) with the test
[test/reply_guard.test.mjs](https://github.com/gavalierm/agent-runtime/blob/main/test/reply_guard.test.mjs). The rules are in `global/CLAUDE.md`, §2 and §5. The rule on files for the operator is in
`env/server/CLAUDE.md`, part "Mailboxes and the waker" ("Schránky a budič"). Approved patterns of repeated work are in
`artifacts/`, and their use is described by `skills/artefakty/SKILL.md`. Neither is in the repo, they are our working
outputs.

## 11. Clean context and continuity

### Problem

The context of a session grows, and every model call reads all of it. A long session is expensive, and the model makes more
mistakes in it. Clearing the context in turn erases everything the agent knew. If the state is not written down, the agent
works blind after clearing, or asks the operator about what was already done.

### When you need it

You need it when sessions run for hours and days, when you pay for every reading of the context, and when you see that the
agent forgets the assignment after long work. You also need it when you want the agent to continue after clearing without the
operator.

You do not need it for short sessions that end on their own. Writing the state to memory and git (the first part of the
chapter) you need always. Add automatic clearing on the agent's command (part "Automatic clearing") only when the first manual
clearing tires you. Until then it is enough that the operator types `/clear` themselves.

### Mechanism

The state of work is in files, not in the context. The memory is in git. The state of a topic is a task with comments and
history in the task manager, not a file in git. Only the persona, rules, decisions and code go into git. Unfinished work at
the end of a turn goes into memory, is committed and pushed. The sentence "I will bring it in the next session" is forbidden.

A clean context is a new session without a conversation, which the agent starts from what is in files. It is done after a
finished logical unit of work, not in the middle of a task. The procedure has four steps.

1. The agent writes the state into memory and into the task.
2. It commits and pushes.
3. It ends the reply with a line that the program watching sessions knows. The handover script prints the line.
4. The program sends the command `/clear` to the same thread, and no model is called. Clearing does not cost a model turn.

The handover is a small file in which the agent passes the new session a summary of the state and possibly the next step. The
handover script prints the line `HOTOVO-KONTEXT <mode> <key>` (HOTOVO-KONTEXT means "context done"). The mode `spanok`
("sleep") only clears the context. The mode `pokracuj` ("continue") sends the agent one more message with the next step after
clearing, and is used only when the next step waits for nobody. The key is a random string that ties the line to the
handover, so a quotation of the word in ordinary text starts nothing.

After clearing no model is called. The session start (fetch, rebase, state) is done by a hook. The hook reads the handover,
deletes it and inserts it into the new session as text, so the model does not read the memory or run fetch until the work
needs it.

The script refuses clearing (code 1) when the agent's task is waiting and the agent commented on it after it entered the
waiting. The agent first changes the state of the task (closes it, resumes it, or sets waiting with a new reason) and only
then starts clearing. Otherwise the result the task was waiting for would stay unprocessed.

The context limit is guarded by a hook that runs on every prompt. It adds up the input tokens of the model's last reply and,
above the limit of 80 thousand tokens, adds an instruction for a clean context to the context. Below the limit it stays
silent.

An agent that runs in two places (the main thread and the task runs in another clone) shares memory, manuals and skills
through git, so after changing them commit and push go right away. Waiting for an outside state is done by a script that
wakes the agent only at a change, not by repeated checks with the model.

### How to build it

#### Writing the state (always)

1. In the persona write a section "Continuity" with the rule for start (fetch, rebase, commits of the other agents) and for
   the end (state into memory, commit, push).
2. In the rules write that clearing goes after a logical unit and not in the middle of a task.

#### Context limit

3. Write a UserPromptSubmit hook. The session transcript is a file whose path the hook gets in its input (`transcript_path`),
   one JSON per line. The hook goes through the lines with the field `usage`, takes `input_tokens`,
   `cache_read_input_tokens` and `cache_creation_input_tokens` from the last one and adds them up. Below 80 000 it stays
   silent. Above the limit it prints an instruction to clear. The instruction says when to clear (after a finished unit, not
   in the middle of a task) and which line to write.

#### Manual clearing (the simplest form)

4. Write the handover script. Usage `kontext.sh spanok|pokracuj [--dalej "<step>"] [--stav "<summary>"]`. It writes the file
   `<state directory>/<session id>.json` with mode `600` (first to a hidden file, then `mv`) with the fields `key` (eight
   random bytes in hexadecimal), `rezim` (mode), `dalej` (next), `stav` (state), `cwd` and `at`. It prints the line
   `HOTOVO-KONTEXT <mode> <key>`. It refuses clearing when the agent's task is waiting.
5. Write a SessionStart hook that runs when `source` in the input is `clear`. The hook does this.
   1. In `cwd` it runs `git fetch origin` and, with a clean tree, `git rebase origin/main`. Never `git pull` or `git stash`.
      It reports an error in the text and does not stop the session.
   2. It reads the handover by the session id and deletes it.
   3. It prints the state, the next step and the result of fetch and rebase, so they are inserted into the new session.
6. The operator types `/clear` after the agent prints the line. So they get the new session with the handover.

#### Automatic clearing

7. Write a program that watches the agents' sessions. When a session finishes a reply, it reads its last non-empty line. The
   line is an instruction only when it is exactly the word `HOTOVO-KONTEXT`, optionally with the mode `spanok` or `pokracuj`
   and with a key of 8 to 64 hexadecimal characters. A quotation of the word elsewhere in the text starts nothing.
8. In the mode `pokracuj` the program verifies that an unused handover with this key exists. If not, it behaves as `spanok`
   and reports a warning.
9. The program checks that the session is not working and sends it the command `/clear`. Right before sending it checks the
   state once more, because a new run may have started in the meantime. In `pokracuj` it sends, after clearing, a single
   message with the next step and marks the handover as used.
10. Store the program's state in a file, so a crash between `/clear` and the continuation does not stay unfinished. Messages
    have a command identifier, so a repeat after a crash does not create a second clearing (chapter 8).

### What it requires from the runtime

- A way to send `/clear` to a session from a program. We send it through the T3 Code server, which starts the agents and
  hands the command to their session. We have not tried another way. If your runtime has none, manual clearing remains.
- A way to find out that a session is not working (chapter 8, part "What your runtime must be able to do").
- A hook at session start that can say the start is after clearing (in Claude Code the field `source` with the value `clear`).
- A hook on prompt that sees the session transcript and the token count of the last reply.
- Clearing that really discards the old conversation. After the first clearing, test it by asking the agent about a fact from
  the previous conversation that was not written to memory. If it knows it, clearing does not work as it should.

For us clearing did not work. T3 Code keeps the session id from the first start for a thread and starts every further process
with `--resume` on it. `/clear` does not change that id, and the old context came back. So when `source` is `clear`, the hook
`clear_bridge.mjs` finds the original id in the command of the parent process, moves the old transcript aside as a backup and
puts a symbolic link to the transcript of the new session in its place. The next `--resume` then loads a clean context. It may
behave differently for you, hence the test above.

### Our example

The clean context rules are in `env/server/CLAUDE.md`, part "Mailboxes and the waker" ("Schránky a budič"). The script is
`bin/kontext.sh`, its logic `lib/kontext.mjs`. The hooks are `hooks/context_warning.mjs` and `hooks/clear_bridge.mjs`. The
files `bin/kontext.sh`, `lib/kontext.mjs`, `hooks/clear_bridge.mjs` and the waker are tied to our runtime and are not in this
repo. The same goes for `hooks/context_warning.mjs`, which calls `bin/kontext.sh`. What each does is in the table "What is not
in the repo" in `README.md`. The waker, the watcher of the other threads and clearing on the agent's word are in the repo
`https://github.com/gavalierm/agent-runtime` (public, D0171). The rule on
unfinished work is in `global/CLAUDE.md`, §6. The parts "Continuity" ("Kontinuita") and "Concurrency" ("Súbežnosť") are shown
by `PERSONA.md` in the agent manager's repo.

## 12. How to start on your own

### Order for the first week

Do not build everything at once. Each step has its own value, and the next one stands on it.

1. Day one, one agent. Create the repo, `PERSONA.md`, the runtime file with the import and `memory/MEMORY.md`. Write the rule
   for the start and the end of a session. Done when a new session after a clean context knows who it is and what was done
   yesterday.
2. Day two, global rules. Write `global/CLAUDE.md` on objectivity, replies, durability, mistakes and autonomy and link it to
   `~/.claude/CLAUDE.md`. Start with a few bullets, not six sections, and build them from the mistakes the agent already made
   for you. Done when the agent follows the rule in a new session.
3. Day three, the decision register. Create `rozhodnutia/`, the schema, the write script and the check. Record the first three
   decisions you already told the agent once. Done when the agent does not ask about them.
4. Day four, the mistake loop. Write the section on mistakes, `chyba.sh`, a hook that stops an acknowledged mistake without a
   record, and a test. Done when the hook stops a test reply "you are right" without a commit.
5. Day five, hooks with a correct procedure. Introduce the `deny` helper and hooks for two mistakes that repeated for you.
   Done when every rejection carries the line "Correct procedure:".
6. Second week, the task manager and the procedure plan, build, check. Only when the agent does several things at once.
7. Second to third week, roles and a second agent. Only when there is work that the first agent should not do.
8. Then mailboxes and the waker (chapter 8). Only when two agents need to send each other results.
9. Last, automatic context clearing (chapter 11, part "Automatic clearing"). You have manual clearing with state written to
   memory from the first day.

### What to postpone

- Mailboxes and the waker, until you have at least two agents. One agent with tasks in a task manager is enough.
- More than two roles, until you have work that belongs to none of them.
- Further roles (designer, development lead, personal assistant) and artifacts, until there is work for them.

### Before your own mechanism

Before every new mechanism, find out whether the tool already does it. The tool you use has documentation, and it handles some
things on its own (wiring hooks, file imports, permission management). A custom installer, a fixed path to the home directory
and a custom shell script are signs that you did not read the documentation. Quote the rules and limits of an outside service
only from its official page, read in full.

The reasons in this playbook come from practice on one server with one operator. The waker, the task manager wrapper and the
hook `clear_bridge.mjs` are tied to our runtime. Chapters 7, 8 and 11 describe how they are built so that you can build them
without our code. Our code is in the repo `https://github.com/gavalierm/agent-runtime` (public, D0171). The rest is portable at once, that is the persona in git, the decision register, the mistake
loop, hooks with a correct procedure and a task with states.
