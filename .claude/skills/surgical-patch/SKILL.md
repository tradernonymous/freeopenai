---
name: surgical-patch
description: "Narrowest possible fix. Use for a bug or small behaviour change where the surrounding code must stay untouched and a regression test proves the fix."
---

# Surgical patch

Reproduce failure first when economical; otherwise capture strongest available evidence.

- Trace symptom to responsible mechanism.
- Change narrowest layer that owns incorrect behavior.
- Preserve unrelated behavior and user changes.
- Avoid cleanup, renaming, and abstraction outside fix.
- Add only regression proof relevant to task.

Run focused proof plus nearest affected gate. Stop when failure is fixed and regression proof passes.
