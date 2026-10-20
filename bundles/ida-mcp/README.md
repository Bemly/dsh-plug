# dsh-ida-mcp (planned npm name)

DSH configuration-only bundle: connects the official Hex-Rays IDA MCP server
over stdio (`uvx ida-mcp stdio --agent=dsh`, IDA 9.4+ with idalib).

Exposes `mcp__ida__*`: `open_database`, `execute_python`, `reference`,
`list_databases`, `save_database`, `close_database`.

Requirements: `uvx` (+ Git), IDA Pro 9.4+ with idalib activated, Python 3.11+.
