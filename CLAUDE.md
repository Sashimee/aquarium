# Aquarium

Photorealistic 3D browser aquarium: freshwater and reef tanks, real fish locomotion, feeding and
play, decorating, accounts, and fish that live or die by your care. **The master plan is
`docs/PLAN.md`; read it before any work.** These rules override `~/.claude/CLAUDE.md` where they
conflict, and only for this repo.

## Hosts

- Dev: `https://devfish.bas.lu` ← `dev`, public, **noindex**
- Prod: `https://fish.bas.lu` ← `main`. `main` moves **only when Alex asks**.
- Dokploy: `https://dok.seil.pro`, project **Bas.lu**. Token in `~/.config/dokploy/seil.token`. Never print it or any env value.
- DNS is done. If a record ever needs changing: the OVH token is at `gitlab01:/etc/letsencrypt/ovh.ini` (root). Run calls **on gitlab01** and never copy the credentials off it.

## Stack

pnpm workspaces · Node 24 · TypeScript strict · Vite · three.js `WebGPURenderer` + TSL (WebGL2
fallback) · React (UI overlay only) · Fastify · Better Auth · Drizzle + Postgres · nodemailer →
`mailrelay:587` from `fish@bas.lu` · vitest · Playwright · gltf-transform.

**Read the installed package's source and types before using an API.** three's WebGPU and TSL
APIs change between releases, and code written from memory will be wrong.

## Commands

```bash
pnpm install
pnpm dev            # web + api with hot reload
pnpm typecheck
pnpm lint
pnpm test           # vitest, all packages
pnpm build
pnpm assets:check   # licence + manifest + size budget
pnpm e2e            # Playwright (from T19)
git config core.hooksPath .githooks   # once per clone: guards main
```

## Repo rules (overrides of the global file)

- **Merging into `dev` is allowed for the orchestrator**: squash-merge a feature PR once CI is green **and** `code-reviewer` approved it. Never merge into `main`. `dev → main` happens only on Alex's explicit request.
- Branches: `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `chore/<issue>-<slug>`, always off **latest `dev`**. One task = one issue = one branch = one PR into `dev`, and the PR body says `Closes #<issue>`.
- **Directory ownership:** every agent file lists the paths it owns. Touching another agent's paths needs a separate small PR. Shared contract files (`packages/shared/**`, `content/species/*.json`, root configs) change in small, contract-first PRs.
- **Assets:** CC0 or CC-BY only. Every asset is in `assets/manifest.json`. Raw downloads live in `~/.cache/aquarium-assets/raw/`: never committed, never executed, and read with `python3 -I` only.
- **Mail relay is a shared live service.** Never edit its config. Test mail goes only to `@bas.lu` addresses.
- **Secrets** in Dokploy env only. Local copies at `~/.config/aquarium/` (mode 600). Generate them alphanumeric.

## Orchestration loop (what each `/loop` iteration does)

The main session is the orchestrator. It does not write feature code itself; it dispatches to the
agents in `.claude/agents/`.

1. **Reconcile.** Read `RESUME.md`, then check it against `git fetch && git log --oneline -15 origin/dev`, `gh pr list --state all --limit 30`, `gh issue list --state all --limit 60`, and running agents (`ListAgents`). The repo state is the truth.
2. **Bootstrap once.** If T00 isn't done, do it inline: monorepo skeleton, `.githooks/pre-push`, `gh repo create Sashimee/aquarium --private`, push, create `dev`, labels `wave:0..8` and `agent:*`, and one issue per task in `docs/PLAN.md` §4 (body: acceptance criteria, dependencies, owned paths). The very first commit lands on `main`, since a repo needs a root, and everything after it goes through `dev`.
3. **Land finished work.** For each open PR into `dev`:
   - CI is red → hand it back to the author agent (`SendMessage` if it's still alive, otherwise a new agent of that type with the PR number).
   - CI is green and there's no review yet → launch `code-reviewer` on it.
   - Approved and green → `gh pr merge <n> --squash --delete-branch`. Then check the devfish deploy with `curl -sI https://devfish.bas.lu/api/health`.
   - Changes requested → back to the author with the review.
4. **Dispatch.** Ready tasks are open issues whose dependencies are all merged into `dev`. Launch every ready task at once; there is no cap on concurrent agents (Alex, 2026-10-19, PLAN §9.1). Use `Agent` with `subagent_type` = the owner agent, `isolation: "worktree"` and `run_in_background: true`. Send independent launches in **one message**. The prompt gives the issue number, the branch name, the acceptance criteria and the dependencies already merged, and says: "commit, push, open a PR into dev with Closes #N, report the PR number".
5. **Record.** Rewrite `RESUME.md` (Goal / Status / State / Blockers / Files; done-log capped at 10).
6. **Pace.** Background agents wake the loop when they finish, so schedule a 1800 s fallback wakeup only.
7. **Stop the loop and notify Alex** (`PushNotification`, then `ScheduleWakeup stop`) when:
   - T23 is done (RC on devfish), so Alex can decide on `dev → main`;
   - a task has failed 3 times: file an issue, label it `blocked`, keep other work going, and stop only if nothing else is ready;
   - something needs Alex: a credential, a licence question (CC-BY-SA), a budget, or a prod action.

Never claim a task is done without its merged PR and a green CI run. Report failures with the actual output.
