# Changelog

## 2026-11-14 — kit supports 0.2.2-rc.3; desktop update flow hardened

**Added**
- `data/official-bundles-0-2-2-rc-3.json` — official bundle lists extracted from
  `@deepseek-ai/dsh-official-bundles@0.2.2-rc.3` (338 packages).
- rc.3 retirement detected: `@deepseek-ai/dsh-experimental-agent-team-profile` is now a
  `RETIRED_BUNDLES` entry (replaced by the unified named-subagent AgentTeam).
- rc.3 new optional bundle: `@deepseek-ai/dsh-deepseek-chat-import` (experimental DeepSeek
  chat import — the "free web import" feature, disabled by default).

**Changed**
- `scripts/install-0.2.2.ps1` is version-agnostic now:
  - reads the pending installer from `update-info.json` (no hardcoded version),
  - verifies sha512 + Authenticode before running,
  - drops retired bundles from `dsh.profile.bundles` with a JSON validation + rollback,
  - force-terminates DSH (a graceful quit races electron-updater and hangs on 0.2.1),
  - runs `--updated /S --force-run`, relaunches, verifies `FileVersion`,
  - appends a run record to `UPGRADE-LOG.md`, pushes it to GitHub, shows a desktop notification.
- `scripts/check-profile-compat.mjs` now reports `RET` (retired) bundles even when they are
  shipped by the installation instead of being present in `node_modules`.

**Fixed / clarified**
- The 0.2.2 compatibility gate uses `semver.satisfies(..., { includePrerelease: true })`;
  `>=0.2.1-rc.x` ranges DO accept `0.2.2-rc.3`. Only exact pins (e.g. `0.2.1-rc.5`) and
  cross-minor lower bounds are skipped.
- Desktop updates can fail with `Host did not complete graceful task teardown ... graceful
  deadline exceeded` — that is a teardown-timeout, not a corrupt download. 0.2.2-rc.3 fixes
  the in-app updater, so the first hop must be done by this script.

## 2026-11-06 — initial kit (0.2.1-rc.5 → 0.2.2-rc.1)

- 30 developer-facing breaking changes, plugin API migration recipes, Windows runbook.
- `check-profile-compat.mjs` with a semver engine verified against `semver@7` (196 cases).
- Official bundle data + community/official duplicate map.
