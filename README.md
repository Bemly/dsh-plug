# dsh-re-toolkit

Reverse-engineering toolkit for [DeepSeek Harness](https://github.com/DeepSeek-AI/DeepSeek-Harness)
(DSH): two MCP client bundles plus one shell CLI skill.

| Path | Provides | Tools |
|---|---|---|
| `bundles/ida-mcp` | Official Hex-Rays IDA MCP (`uvx ida-mcp`), headless IDALib | `mcp__ida__*` (6) |
| `bundles/jadx-mcp` | Headless JADX MCP on JDK 21 | `mcp__jadx__*` (26) |
| `skills/native-re-tools` | Shell recipes: kuna, Ghidra headless, ilspycmd, Hopper CLI | skill (on demand) |

## Status

Working backup from the author's Mac (IDA Pro 9.4, Apple Silicon). Paths in
`cordis.patch.yml` and `SKILL.md` are currently **machine-specific**
(`/Users/bemly/...`) and work as-is on that machine only.

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
bundles/ida-mcp    # row mcp-ida, serverName ida
bundles/jadx-mcp   # row mcp-jadx, serverName jadx
```

Skill (global): copy `skills/native-re-tools` to `~/.dsh/skills/`.
Always-on variant: the same content also lives in `~/.dsh/AGENTS.md`
(not versioned here — machine-local config).
