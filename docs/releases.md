# Releases

Versions are CalVer (YYYY.MM.DD[-beta.N]). All three lines publish to npmjs;
[`publish.yml`](../.github/workflows/publish.yml) admits tags only — do not
publish by hand.

| Tag | Publishes | Channel |
| --- | --- | --- |
| `YYYY.MM.DD` (bare) | `@igorjpimenta/winch` | `latest` |
| `YYYY.MM.DD-beta.N` | `@igorjpimenta/winch` | `beta` |
| `winch-openclaw-<calver>` | `@igorjpimenta/winch-openclaw` | latest or beta by version shape |
| `winch-opencode-<calver>` | `@igorjpimenta/winch-opencode` | latest or beta by version shape |

Tag admission (enforced by the workflow, per package):

1. tag must be CalVer with an optional prerelease suffix, no zero padding;
2. tag must equal the package's `version` exactly;
3. the tag's date must equal the UTC publish date;
4. a version the registry has ever held is refused — a live version skips the
   publish (re-runs stay green), an unpublished tombstone fails hard;
5. core runs `npm ci` and `npm test` before publishing, so a tag whose tests
   fail publishes nothing.

Every tag gets an idempotent GitHub release with the npm link in its notes.

## Auth

Trusted Publishing (OIDC) on every line: the workflow exchanges its id-token
for a short-lived publish token scoped by the package's trusted-publisher
entry on npmjs (repository `igorjpimenta/winch`, workflow `publish.yml`). No
stored token. Each package needs its entry created once on npmjs.com — package
→ Settings → Trusted Publisher — before its first publish through this path;
a freshly created entry can take hours before the exchange accepts it, and the
first publish within two days or the entry expires uneditable.

A package that has never been on npmjs needs one interactive publish before any
of that: the exchange answers `package not found`, so the tag workflow cannot
create it. Run `npm publish --tag beta` from the repo root with 2FA, then
`npm trust github <pkg> --repo igorjpimenta/winch --file publish.yml
--allow-publish`. That version carries no provenance; the next tag does.
A new package's packument 404s for a few minutes after the upload returns 202.

## dist-tags

- a prerelease publishes under `beta`, a stable under `latest`;
- core prereleases never move `latest`, except the first-ever version of a
  package, which npm tags `latest` whatever `--tag` asks for;
- adapter prereleases take `latest` while the line has no stable — adapters
  are installed versionless (`npm:@igorjpimenta/winch-openclaw@latest`), so a
  stale `latest` would serve an old beta — and the first stable takes `latest`
  natively, freezing the rule from then on.

Stable releases publish since 2026.11.9.
