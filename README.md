# dsh-plug

Plug collection for [DeepSeek Harness](https://github.com/DeepSeek-AI/DeepSeek-Harness)
(DSH): RE MCP bundles, browser/computer-use enabler, UI decoration, agent presets, plus one shell CLI skill.

| Path | Provides | Tools / Effect |
|---|---|---|
| `bundles/ida-mcp` | Official Hex-Rays IDA MCP (`uvx ida-mcp`) | `mcp__ida__*` (6) |
| `bundles/jadx-mcp` | Headless JADX MCP on JDK 21 | `mcp__jadx__*` (26) |
| `bundles/idalib-mcp` | IDA Pro MCP in headless IDALib mode (`idalib-mcp`, mrexodia ida-pro-mcp 2.0.0) | `mcp__idalib__*` |
| `bundles/enable-browser-computer` | Enables official experimental Browser Use (Playwright MCP, Chrome launch) + Computer Use (macOS CUA) | browser + CUA rows |
| `bundles/whale-tail-plug` | Whale-tail plugin-button icon (still + hover wiggle) + stacked maid crest, no theme | UI decoration (client) |
| `bundles/opencode-presets` | Two agent presets ported from Bemly/opencode: `nsfw` + `unrestricted` | agent presets |
| `bundles/zako-hub` | Encrypted-payload installer (ex-WorkBuddy hub): decrypts bundled payload and installs it into the current profile | installer bundle |
| `skills/native-re-tools` | Shell recipes: kuna, Ghidra headless, ilspycmd, Hopper CLI | skill (on demand) |

## Status

Working backup from the author's Mac (IDA Pro 9.4, Apple Silicon). Paths in
`cordis.patch.yml` and `SKILL.md` are currently **machine-specific**
(`/Users/bemly/...`) and work as-is on that machine only.

Renamed from `dsh-re-toolkit` to `dsh-plug` on 2026-10-22; old name redirects on GitHub.
`bundles/ida-mcp` and `bundles/jadx-mcp` are the same content as the standalone
`dsh-ida-mcp` / `dsh-jadx-mcp` dirs (plus README); `idalib-mcp`,
`enable-browser-computer`, `whale-tail-plug`, `opencode-presets` were folded in from
the author's current `Documents/Dsh` workdir on the same day.

Roadmap before npm publishing:

- [ ] Resolve tool paths portably (`!!js` + `DSH_HOME`-relative, no hardcoded home dirs)
- [ ] `setup` downloader for Temurin JDK 21 + `jadx-headless-mcp` jar (never ship binaries in npm)
- [ ] Prereq checks (uvx, IDA 9.4 + idalib activation)
- [ ] Parameterize skill paths (`~/.dsh/tools`, `$JAVA_HOME`)
- [ ] `npm publish` `dsh-ida-mcp`, `dsh-jadx-mcp` (names verified free); LICENSE (MIT planned)

## Use (author's machine)

```bash
# install a bundle into the desktop profile
# (via DSH plugin manager: install_bundle with the bundle directory)
bundles/ida-mcp                  # row mcp-ida, serverName ida
bundles/jadx-mcp                 # row mcp-jadx, serverName jadx
bundles/idalib-mcp               # row mcp-idalib, serverName idalib
bundles/enable-browser-computer  # browser-use + computer-use rows
bundles/whale-tail-plug          # tail icon + stacked crest (client)
bundles/opencode-presets          # rows preset-nsfw + preset-unrestricted
bundles/zako-hub                  # encrypted payload installer (zako-hub install)
```

Skill (global): copy `skills/native-re-tools` to `~/.dsh/skills/`.
Always-on variant: the same content also lives in `~/.dsh/AGENTS.md`
(not versioned here — machine-local config).

## Upstream sources

`opencode/` mirrors both branches (`nsfw`, `unrestricted`) of
[Bemly/opencode](https://github.com/Bemly/opencode) — the upstream of
`bundles/opencode-presets`.
