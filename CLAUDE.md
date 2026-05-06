# Maintenance notes for Claude Code

## README changelog

The `## Changelog` section in `README.md` tracks **major and minor** releases only — patches are deliberately omitted.

- **Triggers an entry**: `v1.1.0 → v1.2.0`, `v1.0.0 → v2.0.0`.
- **Does NOT trigger an entry**: `v1.1.1 → v1.1.2` (patches), even if user-visible.

When releasing a new minor or major version, prepend the new entry and trim the list back to **the three most recent major/minor versions**. Each entry should include the version number as a sub-heading and 1–4 bullets describing user-visible changes (not internal refactors).

Patch-level fixes still ship to users via `manifest.json` `version` and git history; they just don't earn a README entry.
