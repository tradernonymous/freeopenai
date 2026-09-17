---
name: safe-refactor
description: "Restructure without changing behaviour. Use for extracting, moving, splitting or cleaning code - especially in the large index.html, chatlib.js and server.js - with tests run before and after."
---

# Safe refactor

Define behavior-preservation boundary and establish verification before structural edits.

- Keep feature changes outside refactor.
- Move one ownership boundary at a time.
- Preserve public interfaces, failure behavior, ordering, and compatibility unless explicitly scoped.
- Keep intermediate states buildable and testable.
- Avoid dependency or configuration growth without correctness need.

Run same proof after change. Stop when behavior matches and requested structure is achieved.
