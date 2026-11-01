# VibeProxy console screenshots

These PNGs are captures of the actual exported console, rendered with the isolated synthetic
API fixtures in `dashboard/scripts/verify-console.ts`. They are interface samples, not live
account activity. Account identities are masked and no real credentials are used.

| File | View |
| --- | --- |
| `overview-dark.png` | Dark overview, quota and routing summary |
| `overview-light.png` | Light overview |
| `quota.png` | Usage windows, reset times, and banked-reset tracking |
| `sessions-cache.png` | Session bindings and prompt-cache counters |
| `credentials.png` | Credential management and recovery state |
| `overview-mobile.png` | Overview at a 390px mobile viewport |

Regenerate from the repository root:

```sh
cd dashboard
bun install --frozen-lockfile
bun run build
bunx playwright install chromium
bun run screenshots
```

The screenshot command also runs the console's browser interaction and accessibility checks.
It dismisses notifications before capturing, waits for fonts and layout, and validates capture
width. If using an existing Chromium install, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

The files in this folder are unaltered browser captures.
