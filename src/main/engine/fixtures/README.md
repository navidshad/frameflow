# CLI engine stream fixtures

Recorded from the real CLIs pointed at FrameFlow's MCP server (with the test's
fake editor), then scrubbed of local paths:

- `claude.stream.jsonl` — Claude Code 2.1.231, `claude -p --output-format stream-json --verbose`
  with the engine's flags. The prompt also asked it to use Bash and Write; it had neither.
- `codex.stream.jsonl` — Codex CLI 0.152.0, `codex exec --json` with the engine's flags. It
  tried an `apply_patch` write, which the read-only sandbox rejected (that never reaches the stream).
- `gemini-badkey.stream.jsonl` — Gemini CLI 0.46.0, `gemini -p -o stream-json` with an invalid API
  key: what a failed run looks like.

`gemini-tools.synthetic.jsonl` is NOT recorded. Gemini CLI could not complete a run on the
machine these were made on (Google refuses its personal-account sign-in), so this file is written
by hand to the event shapes in Gemini CLI 0.46.0's stream formatter (`tool_use`, `tool_result`,
`message` with `delta`, `result`). Replace it with a recording when a signed-in Gemini CLI is available.
