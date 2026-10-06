# Contributing to Archiv

Thanks for helping make Archiv more useful. This is a small personal project, so focused changes with a clear reason and a test are easiest to review.

## Keep personal data out of the repository

Venice archives, browser profiles and diagnostics can contain conversations, media, cookies, session material and recovery keys. Never attach real archive data to an issue or commit it as a fixture.

- Reproduce problems with the smallest synthetic record you can make.
- Replace names, prompts, paths, IDs and media with fictional equivalents.
- Check screenshots and files for metadata before sharing them.
- If you discover a vulnerability or credential, follow [SECURITY.md](SECURITY.md) instead of opening a public issue with details.

## Making a change

1. Use Node.js 18+ and Python 3.9+ on POSIX for storage tests. macOS is required to exercise native ACL/xattr/resource-fork recovery; portable tests do not certify that path.
2. Keep the normal workflow local-first and read-only with respect to live Venice storage.
3. Add or update a synthetic test for behaviour changes.
4. Run `npm test` before opening a pull request (includes release/privacy checks). Use `npm run check:release` for a standalone packaging check.
5. Explain the user problem and any archive-format or privacy implications in the pull request.

Use short imperative commit subjects describing the change. Document storage-format, migration and consumer-compatibility changes in [CHANGELOG.md](CHANGELOG.md) and the relevant guide; include preservation/restore expectations, not personal archive measurements or diagnostics.

The project deliberately has no third-party runtime packages. Please discuss a new dependency before adding one, and include its licence and security implications.

## Licence

By contributing, you agree that your contribution is submitted under the project's [GNU AGPL v3-only licence](LICENSE) and that you have the right to provide it on those terms. Third-party code must be clearly identified and compatible with the project licence.
