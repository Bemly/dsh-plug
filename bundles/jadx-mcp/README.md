# dsh-jadx-mcp (planned npm name)

DSH configuration-only bundle: connects the headless JADX MCP server
(`jadx-headless-mcp-0.7.1`) over stdio, running on JDK 21.

Exposes `mcp__jadx__*` (26 tools): `status`, `load_apk`, `get_class_source`,
`get_method_body`, `search_classes_by_keyword`, xrefs, strings, resources, …

Requirements: JDK 21 + `jadx-headless-mcp-0.7.1-all.jar` under
`~/.dsh/tools/{jdk,jadx}` (currently provisioned by hand; a `setup`
downloader is planned before npm publishing).
