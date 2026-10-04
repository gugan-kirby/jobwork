# Delivery workflow

How work reaches `main`, from IN-12 onward (agreed with the product owner, 2026-10-04). It extends the execution protocol in [README](README.md) — plan first, one functionality at a time, tests green before moving on — with branches, commit discipline and publishing. It applies the same way whether a person or an unattended overnight run does the work.

## 1. Branches

- `main` is always green and releasable. Nothing is committed to it directly; everything arrives through a pull request.
- One branch per unit of work, cut from up-to-date `main`:

  | Work | Branch |
  |---|---|
  | Refreshing an increment's plan | `plan/in-12-refresh` |
  | One functionality | `feat/f-12-1-pilot-scenarios` |
  | A defect found on the way | `fix/<topic>` |
  | Pipeline or tooling | `ci/<topic>` |
  | Documentation only | `docs/<topic>` |
  | Closing an increment | `docs/close-in-12` |

- A branch lives for hours, not days. If a functionality turns out larger than planned, it is split into further `feat/` branches and the plan file says so.

## 2. Commits

- Small commits by area, in the order the work was built: migration, contracts, domain, command and its tests, worker, UI component, screen, plan notes. Each commit should build on its own where practical.
- Conventional prefixes: `feat(api):`, `fix(worker):`, `test(api):`, `feat(portal):`, `docs:`, `ci:`, `chore(deps):`.
- Messages say what changed and why, in the domain's words.
- No attribution to tools of any kind in messages, trailers, pull requests or files (no `Co-Authored-By`, no "generated with"). Commits are authored as the repository owner.
- History is never squashed or rewritten after a push: a red build is fixed by a new commit on the same branch.

## 3. Publishing a branch

1. **Local gate**: `pnpm -r build && pnpm typecheck && pnpm lint && TZ=Asia/Kolkata pnpm test` green; for UI work, the screen checked in a browser (phone and desktop widths).
2. **Hygiene**: no tool attribution in messages or tree; files excluded via `.git/info/exclude` (`CLAUDE.md`, `AGENTS.md`, `.claude/`) are not tracked.
3. **Push and open a pull request** against `main`: the title names the functionality (`F-12.1 Pilot scenario harness`); the body says what changed, which tests prove it, deviations from the plan, and what was verified in a browser, and links the plan file.
4. **CI must pass on the pull request.** A failure is investigated and fixed on the branch.
5. **Merge with a merge commit** — the branch's commits stay visible in `main`'s history — and delete the branch.
6. Pull `main` before cutting the next branch.

## 4. Unattended (overnight) runs

**Order.** IN-12 (refresh its plan, then F-12.1–F-12.4, then close), then Phase 2: IN-13 to IN-18, each refreshed against the codebase before it is built. Doc 24 §5 fixes Phase 2's sequencing "at Phase 1 exit using what the pilot taught"; with no pilot yet, the indicative order is used, recorded as a decision taken on the owner's behalf in IN-13's plan.

**Guardrails.**

| Rule | Why |
|---|---|
| No production system, real credential, real money or real provider is touched | `DO-02`, `DO-13`; providers sit behind ports with simulated adapters until their `T-0x` decision |
| A decision that belongs to the owner — a provider, a business policy, a UAT sign-off, booking a penetration test — does not block the run: the documented safe default is taken and recorded in the increment file under **Decisions taken on the owner's behalf** | The owner reviews them in the morning instead of the run stopping at midnight |
| New system software is installed only when a functionality cannot otherwise be verified, and the plan file records it | The machine stays the owner's |
| Stop a line of work, record why, and move to the next independent one when: `main` is red and the fix is not this branch's; a change would need to rewrite an immutable record or history; a security finding needs the owner | Better a clear note than a guess |
| Progress is recorded where the next session will look: the status board in [README](README.md), each increment's exit checklist, and the session memory | Any session can resume exactly |

**Morning summary.** Pull requests merged, test count before and after, defects found and fixed, decisions taken on the owner's behalf, and what is waiting for the owner.
