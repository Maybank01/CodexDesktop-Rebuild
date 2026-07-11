# Codex Desktop Rebuild

Cross-platform Electron build for OpenAI Codex Desktop App.

## Supported Platforms

| Platform | Architecture | Status |
|----------|--------------|--------|
| macOS    | x64, arm64   | ✅     |
| Windows  | x64          | ✅     |
| Linux    | x64, arm64   | ✅     |

## Build

```bash
# Install dependencies
npm install

# Build for current platform
npm run build

# Build for specific platform
npm run build:mac-x64
npm run build:mac-arm64
npm run build:win-x64
npm run build:linux-x64
npm run build:linux-arm64

# Build all platforms
npm run build:all
```

Windows builds require 7-Zip (`7zz` or `7z`) on `PATH`. The portable app is
written to `out/win/Codex-win32-x64/`. Current upstream versions declare
`ChatGPT.exe` as the official entrypoint; the build also maps it to `Codex.exe`
for AgentRouter Client and older portable launchers. The distributable ZIP is
written directly under `out/`.

Desktop builds keep the official upstream Codex CLI by default so the UI and
runtime model catalog remain on the same release. Set
`CODEX_RUNTIME_SOURCE=cometix` only when an explicit Cometix compatibility
build is required. Linux builds still use the platform-native Cometix runtime.

### Windows component artifacts

AgentRouter Client can install the Windows Desktop Shell and Codex Core as two
independently verified artifacts. The first Core component format owns exactly
`resources/codex.exe` plus `agentrouter-core.json`; the Shell intentionally has
no `resources/codex.exe` and includes `agentrouter-shell.json` instead. A Shell
must never be activated before composition succeeds.

```powershell
# Force a fresh Store download in an isolated cache. The Shell version is read
# from src/win/_asar/package.json; the Store package version is recorded
# independently in scripts/.versions.json.
node scripts/sync-upstream.js --force --skip-mac --refresh-download --cache-key windows-latest
node scripts/patch-all.js win
npm run build:win-shell -- --cache-key windows-latest

# Package a source-built AgentRouter codex.exe and compose a test Runtime.
node scripts/package-windows-core.js --input C:\path\to\codex.exe
node scripts/compose-windows-runtime.js --shell out\Codex-Desktop-Shell-win-x64-<desktop-version>.zip --core out\Codex-Core-win-x64-<core-version>.zip
node scripts/verify-windows-components.js --shell <shell.zip> --core <core.zip> --composite <composite.zip>

# After both immutable release URLs are known, generate the Client v2 pointer.
node scripts/generate-runtime-components-manifest.js --channel dev --minimum-client-version 0.1.75 --published-at 2026-07-12T00:00:00Z --shell <shell.zip> --shell-url <https-url> --core <core.zip> --core-url <https-url> --output out/runtime-components-dev.json
```

`npm run build:win-x64` remains the legacy one-file build and defaults to
`--artifact composite`. The manual `Windows Components (Manual Test)` workflow
builds test artifacts only; it does not create a tag or GitHub Release and does
not require an OpenAI Authenticode signature.

## Development

```bash
npm run dev
```

## Project Structure

```
├── src/
│   ├── .vite/build/     # Main process (Electron)
│   └── webview/         # Renderer (Frontend)
├── resources/
│   ├── electron.icns    # App icon
│   └── notification.wav # Sound
├── scripts/
│   └── patch-copyright.js
├── forge.config.js      # Electron Forge config
└── package.json
```

## CI/CD

GitHub Actions automatically builds on:
- Push to `master`
- Tag `v*` → Creates draft release

## Credits

**© OpenAI · Cometix Space**

- [OpenAI Codex](https://github.com/openai/codex) - Original Codex CLI (Apache-2.0)
- [Cometix Space](https://github.com/Haleclipse) - Cross-platform rebuild & [@cometix/codex](https://www.npmjs.com/package/@cometix/codex) binaries
- [Electron Forge](https://www.electronforge.io/) - Build toolchain

## License

This project rebuilds the Codex Desktop app for cross-platform distribution.
Original Codex CLI by OpenAI is licensed under Apache-2.0.
