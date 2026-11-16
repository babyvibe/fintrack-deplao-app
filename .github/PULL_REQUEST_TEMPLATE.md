## What changed and why

<!-- One purpose per PR. Link the issue if there is one: Fixes #… -->

## How to test

<!-- Commands / clicks a reviewer can repeat. -->

## Checklist

- [ ] `npm test` and `npm run validate` pass
- [ ] Tests added / updated for the new behavior (`test/`, fakes in `test/helpers/fakes.js`)
- [ ] Permissions or contract changed (`deplao-plugin.json`, `docs/CONTRACTS.md`) → README and CONTRACTS updated, and the change explained above
- [ ] `CHANGELOG.md` updated (under *Unreleased*) if users can see the change
- [ ] No secrets, tokens or message content logged or exposed
