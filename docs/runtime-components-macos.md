# AgentRouter macOS Runtime components

`macos-components.yml` produces the Codex Desktop Shell for Apple Silicon and Intel.
It removes the bundled Codex CLI before signing the app and records an external Core
contract in `agentrouter-shell.json`. The installed Client must provide the selected
Core executable through `CODEX_CLI_PATH`.

The workflow runs when relevant packaging or upstream-version files change on
`master`, when an `agentrouter-shell-v*` tag is pushed, or when it is manually
dispatched. Default-branch and tag runs require Developer ID signing and Apple
notarization. Manual runs may use ad-hoc signing for an internal build probe.

Produced ZIPs are seven-day candidates. The workflow intentionally does not publish a
GitHub release or update any AgentRouter Runtime channel. Composition with a Core,
installed-process acceptance, and channel promotion remain separate controlled steps.

Repository Actions secrets required for publishable runs are
`APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER_ID`. The
workflow derives the exact signing identity from the imported temporary keychain.
