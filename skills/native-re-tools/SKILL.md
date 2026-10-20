---
name: native-re-tools
description: Drive the native RE CLIs on this Mac via shell: Ghidra headless, kuna decompiler, ilspycmd (.NET), Hopper CLI. Use when analyzing binaries outside the IDA/jadx MCP servers, or when a scripted CLI flow fits better than MCP tools.
---

# Native RE CLI tooling (this machine)

All paths below are verified on this host. Prefer MCP servers (`mcp__ida__*`,
`mcp__jadx__*`) for interactive analysis; use these CLIs for batch/scripted work.
`~/.dsh` = `/Users/bemly/.dsh`.

## kuna 1.833 (fast decompiler, no server needed)

Binary: `/Users/bemly/.dsh/tools/kuna/kuna-v1.833-macos-x86_64/kuna`

```bash
K=/Users/bemly/.dsh/tools/kuna/kuna-v1.833-macos-x86_64/kuna
$K functions ./prog --json                 # enumerate functions (structured)
$K decompile ./prog main                   # decompile one function to C
$K decompile ./prog 0x401230 --addr --json  # by address, JSON output
$K decompile-project ./prog -o ./prog.kuna # full export; read index.jsonl + *.c
$K decompile-all ./prog --json             # batch structured output
$K xrefs ./prog --to main --json           # who calls main (--from for callees)
$K strings ./prog --json                   # strings (+ --filter REGEX)
$K disassemble ./prog main                 # disassembly view
$K crypto ./prog --json                    # crypto constants scan
$K unpack ./prog -o out/                   # unpacker stubs (UPX etc.)
```

Self-help (embedded in the binary, no network): `$K docs <topic>`,
`$K modes`, `$K catalog`, and the full guide via `$K install-skill --print`.
Add `--isa arm|thumb` for ARM firmware, `--raw-image --target T --base VMA`
for raw blobs, `--mode reliable|aggressive|fast` to trade speed vs depth.

## Ghidra 12.1.4 headless

```bash
export JAVA_HOME=/Users/bemly/.dsh/tools/jdk   # system java is 1.8, unusable
GH=/Users/bemly/.dsh/tools/ghidra/support/analyzeHeadless
$GH /tmp/ghidra_proj MyProj -import /path/to/binary -deleteProject
```

Useful flags (from `analyzeHeadless` usage): `-processor <languageID>`
(`-cspec <compilerSpecID>`) to force arch/ABI, `-noanalysis` to skip auto
analysis, `-scriptPath <dir> -postScript <Name>` to run your own export script,
`-log <file>` for diagnostics. Without `-deleteProject` the analyzed project
stays under the project dir for GUI revisit. There is no bundled
"export all decompilation" script — for bulk C output prefer kuna/IDA; use
Ghidra headless for scripted structure queries via custom `-postScript`.

## ilspycmd 11.1.0 (.NET decompiler)

Binary: `/Users/bemly/.dotnet/tools/ilspycmd` (dotnet global tool)

```bash
I=~/.dotnet/tools/ilspycmd
$I app.dll -o out/                    # decompile assembly to source tree
$I app.dll -t Ns.Type -o out/         # single type only
$I app.dll -m "M:Ns.T.M()" -o out/    # single member (doc-id or 0x token)
$I app.dll -p -o out/                 # decompile as compilable project
$I app.dll -l c                       # list classes (i/s/d/e for iface/struct/delegate/enum)
$I app.dll --list-resources           # embedded resources
$I app.dll --dump-table TypeDef       # metadata tables (+ --json for JSON)
```

## Hopper Disassembler v4 (interactive-first)

Binary: `/Applications/Hopper Disassembler v4.app/Contents/MacOS/hopper`

```bash
"/Applications/Hopper Disassembler v4.app/Contents/MacOS/hopper" -e /path/binary
"/Applications/Hopper Disassembler v4.app/Contents/MacOS/hopper" -d saved.hop
"/Applications/Hopper Disassembler v4.app/Contents/MacOS/hopper" -e /path/binary -Y script.py
```

Verified CLI surface is only: `-e` open file, `-d` open saved `.hop` doc,
`-l loader_id [options]` loader select, `-Y script.py` run script. It is a GUI
launcher — no headless batch decompile/export. For scripted flows use
IDA (`mcp__ida__*`), kuna, or Ghidra above; use Hopper for interactive macOS
binary work (the former REA Hopper bridge is gone with the REA bundle).
