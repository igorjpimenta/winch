# Releases

Versions are CalVer (YYYY.MM.DD[-beta.N]). The CI contract:

- tag == package.json version
- tag date == UTC publish date
- bare tag = core package, prefixed = adapter
- prerelease (hyphen) -> beta dist-tag
- stable (no hyphen) -> latest dist-tag
- betas never move latest

Stable releases publish since 2026.11.9.
