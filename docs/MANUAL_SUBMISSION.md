# Submit these changes yourself

No commit, push or pull request was made by Codex in this session. The workspace is detached at the fetched `main` commit so no new branch was created. The commands below commit your reviewed working files and update the **existing** remote `feat/stakelane-compare` branch.

Run from a terminal after reading the validation report and reviewing the diff:

```sh
cd /home/roo/Documents/ChatGPT/ethmumbhai
git status --short
git diff --check
git diff --stat
git config --get user.name
git config --get user.email
```

If the last two values are empty, configure your own correct commit name/email before committing. Do not copy another contributor's identity. GitHub's account used for a push and a commit's author are separate metadata; manual submission does not make AI-assisted work human-only. Retain `AI_USAGE.md`.

Stage and review the changes:

```sh
git add .gitignore README.md LICENSE AI_USAGE.md DEMO.md docs/ sidecar/ stakelane
git diff --cached --stat
git diff --cached --check
git diff --cached -- . ":(exclude)sidecar/evidence"
git commit -m "Harden admission scheduling and improve the operator workflow"
```

Dependencies, `.runtime/`, participant keys and `results/` are ignored. Inspect staged files yourself before committing. Only curated private-test evidence under `sidecar/evidence/hardening/` should be included, never runtime logs, JWTs or participant state.

Push the detached commit to the existing feature branch, without creating another branch or force-pushing:

```sh
git -c credential.helper= -c 'credential.helper=!/usr/bin/gh auth git-credential' push origin HEAD:feat/stakelane-compare
```

This uses the authenticated GitHub CLI and avoids this machine's broken legacy credential-helper path. If the push is rejected because the remote branch has advanced, stop, fetch and review that work; do not force-push over it.

Open a PR against main:

```sh
gh pr create --repo Pradeeppilotdev/stakelane --base main --head feat/stakelane-compare --title "Bound simulation work and verify admission scheduling trade-offs" --body-file docs/PR_DESCRIPTION.md
```

If an open PR already uses that branch, the push updates it; use `gh pr edit <number> --repo Pradeeppilotdev/stakelane --body-file docs/PR_DESCRIPTION.md` instead. Review and merge manually after checking CI and the evidence. None of these commands deploys a service or sends a public-chain transaction.
