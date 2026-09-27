// =============================================================================
// Bash tool description.
//
// Kept out of bash.ts because it is prose, not logic: it gets iterated on
// independently of the executor, and it is the only lever we have over *which*
// tool the model reaches for. The routing section below is the point — a
// `cat`/`grep`/`find` run through the shell costs far more context than the
// dedicated tool (no line numbers, no per-tool caps, no read dedup), and the
// model will default to the shell unless told not to.
// =============================================================================

export const BASH_DESCRIPTION = `Run a shell command — for terminal operations: git, package managers, build/test runners, docker, toolchains, one-off scripts.

## Do not use bash for file operations

Dedicated tools cost less context and give more: \`read\` (NOT cat/head/tail/sed -n — it caps output, takes offset/limit, dedups re-reads), \`glob\` (NOT find), \`ls\` for one directory, \`grep\` (NOT grep/rg/ag), \`write\` (NOT echo >/heredoc), \`edit\` (NOT sed -i/awk/perl -i). Use bash for file work only where no tool covers it — \`mv\`, \`chmod\`, \`mkdir -p\`, pipes.

## Running commands

- Non-interactive only: stdin is closed; pass \`-y\`/\`--yes\`/\`--no-input\`.
- Use \`workdir\` instead of \`cd\` (does not carry over). Quote paths with spaces.
- \`timeout\` is milliseconds (default 60000, max 600000 = 10 minutes). A command still running when it expires is moved to the background, not killed — unless you set \`timeout\` below the max yourself, which means "kill it then".
- Chain dependent steps with \`&&\`; send independent commands as parallel tool calls in one message.
- Output is capped; the truncation marker names the \`output\` tool call that pages the rest — use it instead of re-running.

## Long-running commands

Use \`run_in_background: true\` for anything that does not exit on its own — a dev server, a watcher, \`docker compose up\`, \`tail -f\` — and for anything that may run longer than 10 minutes: full test or eval suites, long builds, data jobs. It returns a shell id immediately instead of holding the turn until the timeout kills it.

- When a background command exits you get a \`<task-notification>\` with its exit code and the tail of its output. Do not poll, and never \`sleep\` waiting for it: carry on with other work, or end your turn and report when the notification arrives.
- \`bashoutput(bash_id)\` returns only the output that arrived since your last call, plus status and exit code — use it to check progress or read more than the notification's tail. Do not re-run the command to see more.
- \`killbash(bash_id)\` stops it and its whole process tree. Stop what you started once you are done with it.
- A build or test suite that takes a few minutes can stay in the foreground with a raised \`timeout\`; background it if it might pass 10 minutes or you have other work to do meanwhile.

## Git

- Before committing: \`git status\`, \`git diff\`, \`git log --oneline -10\` to match message style; stage files by name — \`git add -A\` sweeps in secrets and other agents' work. Use \`gh\` for PRs/issues/checks.
- Never skip hooks (\`--no-verify\`) or change git config. After a hook rejection make a NEW commit, not \`--amend\`. \`push --force\`, \`reset --hard\`, \`checkout .\`, \`clean -f\`, \`branch -D\` only on explicit request.`;
