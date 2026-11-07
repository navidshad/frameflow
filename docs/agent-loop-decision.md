# Agent loop for non-CLI models: decision record

Date: 2026-11-07. Status: decided and built.

## The need

The Claude Code engine gets its quality from a real agent loop: many tool calls
per turn, parallel reads, looking at frames, planning, a long context kept
manageable, abort, a budget, a conversation that continues. The Gemini engine
does none of that: it is one structured call (or a survey call plus a detail
call) that returns a bundle of ops. We want Gemini now, and OpenRouter models
later (cheaper ones), to drive FrameFlow's own MCP tools the way Claude does.

The loop must reach the tools the same way the CLI does. The per-turn
`AgentServer` (`src/main/mcp/server.ts`) is a loopback HTTP MCP server with a
token, permissions, step budget and commit tracking. Any candidate with an MCP
client can drive it unchanged, so the question is only which loop runs best.

## Options

Numbers are from the npm registry and a scratch install on 2026-11-07.

| Option | Version, last release | Install size (deps) | Licence | Fit |
| --- | --- | --- | --- | --- |
| **Vercel AI SDK v7** (`ai`, `@ai-sdk/mcp`, `@ai-sdk/google`, `@openrouter/ai-sdk-provider`) | 7.0.164, 2 days ago | 48 MB (107 pkgs) | Apache-2.0 | `ToolLoopAgent`, `stopWhen`, `prepareStep`, step/tool lifecycle hooks, abort, MCP client over HTTP. Gemini and OpenRouter providers. No built-in compaction or planning |
| LangChain **Deep Agents** (`deepagents` + LangGraph + `@langchain/google` + `@langchain/mcp-adapters`) | 1.16.3, 1 day ago | 167 MB (92 pkgs) | MIT | Planning, virtual file system, sub-agents, summarisation, all built in. Peer-depends on `@langchain/anthropic` and `@langchain/openai`, `langsmith`, LangGraph SDK and checkpoint |
| Plain LangGraph.js | 1.7.2 | part of the above | MIT | The same runtime without the batteries; we would write the loop nodes ourselves on a heavier base than the AI SDK |
| pi agent core (`@earendil-works/pi-agent-core` on `pi-ai`) | 1.5.0, 5 days ago | 97 MB (88 pkgs, includes AWS, Anthropic, Mistral SDKs) | MIT | A lean `Agent` with `transformContext`; no MCP client, so every tool would be bridged by hand |
| Mastra (`@mastra/core`) | 1.82.0 | 89 MB alone, 30 deps (hono, execa, ...) | Apache-2.0 | A server framework; far more than a loop |
| OpenAI Agents SDK (JS) | 0.21.0 | small core | MIT | OpenAI-first; other providers only through the AI SDK, so it adds a layer on top of option 1 |
| Google ADK for TypeScript | 2.4.0 | 10 MB, 25 deps (mikro-orm, a2a, OpenTelemetry, Docker types) | Apache-2.0 | Gemini-centred; nothing for OpenRouter; a heavy tree for a loop |
| In-house loop on `@google/genai` + the MCP SDK (both already dependencies) | n/a | +0 MB | n/a | We would own retries, Gemini thought signatures, a second provider adapter, compaction, hooks: the thing the user asked us to stop hand-rolling |

Dependency licences were scanned for the two finalists: every package is MIT,
Apache-2.0, ISC or BSD, plus one public-domain package. Nothing blocks shipping
either inside a PolyForm Noncommercial app (NOTICE entries still apply).

## What was tested

Both finalists drove FrameFlow's real tools (the real `AgentServer` over an
in-memory editor, MCP over HTTP with the bearer token) with real
`gemini-3.6-flash`, on the same request ("look at the project and its timeline,
then make one useful edit that tightens the cut").

| | AI SDK v7 | Deep Agents |
| --- | --- | --- |
| Completes the edit | yes: 5 steps, 12.5 s | yes: 6 steps, 20.8 s |
| Parallel tool calls | yes (2 per step) | yes |
| Verifies its own edit | yes (re-reads the timeline) | yes |
| Prompt tokens, first call | 11.9k | 13.7k (its own prompt and built-in tools add about 1.7k to every call) |
| Abort mid-run | stops at once, `AbortError` | not run |
| Step limit | stops cleanly; the final text is empty, so we add a wrap-up step | not run |
| **Sees a `render_frame` picture** | **yes**: described the returned green pixel correctly | **no**: tool result arrived as `[object Object]`; it called the picture black, then went looking with its own `glob` and `ls` |
| Compaction | `prepareStep` clearing old tool results kept input flat at 12 to 13k tokens over 7 steps | built-in summarisation, tied to its file system |
| OpenRouter | provider works through the same loop; parallel calls; real cost in provider metadata | `@langchain/openrouter` exists; not run |

The OpenRouter run used a stub endpoint (no OpenRouter key here), so it proves
the wiring and the request shape, not a live model.

## Decision

**Use the Vercel AI SDK v7 `ToolLoopAgent` as the loop**, behind an engine
abstraction in FrameFlow, reaching the tools through the per-turn MCP server.
Build the three things that make Claude Code feel like Claude Code on top of
it, in our code: a step budget with a wrap-up step, context compaction in
`prepareStep`, and a small planning tool that feeds the chat.

Why not Deep Agents, the user's first suggestion:

- Its defining pieces are a file system, sub-agents and file-based context
  management. FrameFlow has no files for the model to work with. Both
  `FilesystemMiddleware` and `SubAgentMiddleware` are required and cannot be
  excluded; only individual tools can be hidden. In the spike the model reached
  for `glob` and `ls` when a picture did not arrive.
- Looking at frames is central to FrameFlow, and the picture did not reach
  Gemini through the LangChain MCP adapter. Fixable with our own wrapper, but
  then we own that glue as well as a framework.
- 3.5 times the install size, a peer-dependency graph that pulls in two
  provider SDKs we do not use, and a 0.x Gemini integration.

Why not an in-house loop: the user asked for a solid loop instead of our small
custom ones. The AI SDK gives us the provider quirks (Gemini thought
signatures worked across five steps), retries, usage and cost, typed hooks and
two providers for free, and it is the one most likely to keep up.

## What we give up

- Planning, summarisation and sub-agents are not built in. We write a small
  planning tool and a clearing-style compaction (tested), and leave sub-agents
  out until a task needs one.
- `ai` is a young major (v7, many patch releases). We pin the version and keep
  every use of it inside one module so a change touches one file.
- No live OpenRouter run yet; adding it is a provider, a model list and a key.

## What the build showed on a real project

The same request on a real 8-minute vlog (263 timeline items, motion layers),
"tighten the first minute: cut dead air and false starts, keep the motion layers
lined up", through the real app, one run each:

| | Gemini 3 Flash Preview, first build | Gemini 3 Flash Preview, after the fixes below | Claude Code, Opus 5.5 at Medium |
| --- | --- | --- | --- |
| Time | about 3 minutes | 83 s | 322 s |
| Steps | 22, one failed (`begin_round`) | 10, none failed | 17, none failed |
| Revisions | 1 (after reverting its first try) | 1 | 4 (and one revert) |
| Prompt tokens | 1.56M over 21 calls, 24k growing to 97k a call | 0.48M over 11 calls, 0.31M of it cached | not reported |
| Cost | about $0.92, cache ignored | about $0.15 | your plan |
| Timeline change | 8:15.0 to 8:08.8 | 8:15.0 to 8:06.5 (said 15.8 s, measured 8.5 s) | 8:15.0 to 8:11.6 (said 3.4 s, measured 3.4 s) |
| Looked at frames | no | no | yes, three renders |

What changed between the first and second Gemini runs, and why it is in the build:
every step re-sends the conversation, so ten `get_timeline` reads at full size
made each call dearer than the last. Compaction now keeps the newest five results
whole and clears older big ones; the loop's prompt says each call re-sends
everything; cached prompt tokens are billed at a tenth, as Google publishes; and
the round tools (`begin_round`, `end_round`) are no longer offered to an engine,
which had called one and been told it was not for it.

Honest read of the comparison: Gemini was faster and cheaper and made a sensible
edit, but it did not check its work and over-reported what it removed. Claude
edited more carefully (it rejoined split motion cards, left pauses under timed
graphics alone and said why) and verified with frames.

## Closing the gap: the review

Telling a model to check its work is easy to skip. So the loop does not take the
agent's "done" after an edit as the end of the turn (`shared/turnReview.ts`,
`runLoopTurn`):

1. **A working checklist in the loop's prompt**: read, plan with the last step
   "Check the result", edit, look at frames on both sides of each change, fix,
   answer with measured numbers. Loop engines only; the shared baseline and so
   Claude Desktop are unchanged.
2. **A review FrameFlow measures itself.** When the agent stops after editing,
   the loop compares the timeline before and after the turn and sends back what
   it found: the real change in length, the new joins (the places to look), motion
   layers a cut left in pieces, slivers of footage too short to see, and whether
   it has looked at a frame since its last edit. Then the checklist again, with
   the user's request quoted, and the instruction to answer with those numbers.
   A second review follows only if it edited again or still had not looked.
3. **The card says what was skipped**: a turn that never looked at a frame after
   its last edit, or ran out of calls before the review, says so beside the answer.

Two runs of the same request with the review, Gemini 3 Flash Preview:

| | Review run 1 | Review run 2 | Before the review | Claude Code |
| --- | --- | --- | --- | --- |
| Time | 353 s | 395 s | 83 s | 322 s |
| Model calls | 17 | 18 | 11 | not reported |
| Cost | $0.28 | $0.26 | $0.15 | your plan |
| Planned | yes | yes | yes | no |
| Looked at frames | 4 renders | 4 renders | none | 3 renders |
| Rejoined motion layers split by its cuts | yes, 7 | yes | no | yes |
| Said vs measured | 13.0 s, 8:02.1; measured 8:02.1 | 8.4 s, 8:06.7; measured 8:06.7 | 15.8 s; measured 8.5 s | 3.4 s; measured 3.4 s |

The review costs about 1.8 times the tokens and as long as Claude takes, and in
return the agent looks at its work, fixes what its cuts broke, and reports what
is true. It still cuts harder than Claude did (8 to 13 s against 3.4 s, where
Claude left pauses under timed graphics alone on purpose); whether a cut runs
through a word cannot be judged from pictures, and was not checked here.
