# ADR 0001: the MCP host lives in the desktop shell

Status: accepted (2026-09-22). Decided ahead of Phase 1 of the desktop
roadmap, before any tool loop is written.

## Context

Chat on the desktop app never sends tool definitions (`desktop/src/api.ts`
`streamChat`), and no NeuraOS surface -- web, APK or desktop -- speaks MCP.
None of the backends the app can talk to is an MCP client: llama-server,
Ollama and the Hugging Face router all take OpenAI-shaped `tools` JSON and
answer with `tool_calls`. Somebody has to own the servers, the approvals and
the conversion, and it has to be the app.

## Decision

1. **The Rust shell is the MCP host.** Local `stdio` servers are spawned,
   supervised and reaped by the shell (the way `models.rs` owns llama-server),
   so a server cannot outlive the window. Remote `http`/SSE servers go through
   the same client type in the shell, behind the host allowlist in `net.rs`.
2. **One tool catalogue.** The shell exposes every tool -- built-in
   (filesystem, terminal, web search) and MCP -- as one list in the OpenAI
   `tools` shape. The frontend never learns which transport a tool came from,
   and every backend gets the same JSON.
3. **Approvals are inline.** A tool call is a card in the chat with Allow /
   Deny, not a separate panel. "Every file write, command and commit waits for
   an explicit Approve" (the standing rule for this app) is enforced in the
   shell, before the tool runs, not in the screen.
4. **Repo-supplied `mcp.json` is untrusted.** A server named by a file in a
   folder the user opened is offered behind a trust prompt naming the command
   it would run, and remembered per folder -- the same gate Codebuff puts on
   repository MCP config.
5. **Model floor.** Tool calling is offered only with a quant the runtime can
   actually parse tool calls from: llama-server with `--jinja`, and never a
   1-bit Unsloth quant (their own guide says those break tool use).

## Consequences

- Phase 1 builds `mcp.rs` next to `models.rs`, and `tools.js` (pure, tested)
  for the catalogue and the approval rules.
- `local_model_start` must always pass `--jinja` (done in Phase 0, item 0.6).
- The web app and APK do not get MCP from this; the engine would need its own
  host. That is a later decision, not this one.
