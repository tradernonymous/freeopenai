---
name: lean-build
description: "Build a feature as the smallest complete slice. Use for new behaviour, integrations or provider additions where overbuilding is a risk and the stop condition must be explicit."
---

# Lean build

Architecture-first simplicity is mandatory. Turn the feature into a complete narrow outcome that fits the system.

- Derive observable acceptance and explicit non-goals from request and repository.
- Trace entry point through layers owning invariants.
- Deliver coherent end-to-end path across responsible layers; never force work into one file, direct expression, or local patch.
- Reuse fitting seam. Refactor when patching duplicates behavior, weakens ownership, or hides root cause.
- Omit modes, providers, config, extensibility, and polish unless acceptance needs them.
- Add surface, dependency, service, config, or migration only for lifecycle design or acceptance; state material tradeoff.
- Keep work runnable; preserve existing safety checks and tests.

Exercise path. Run focused proof. Stop when acceptance passes. Report only material omissions and trigger.
