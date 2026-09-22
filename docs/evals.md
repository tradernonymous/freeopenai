# Evals in CI

`node scripts/run-evals.js` scores the app's **deterministic layer** against
checked-in cases and prints one line:

```
evals: 48/48 (100%), threshold 100%
```

It runs as the `Evals` step of the `test` job in `.github/workflows/ci.yml`, so
every push and pull request produces that number, and the job goes red when the
score falls below the threshold in `evals/threshold.json`.

## What the score is not

**It is not a model benchmark.** Nothing here calls a model, and nothing here
touches the network. CI has no API key and no local server, so the model is
*scripted*: every "reply" is a fixture checked into `evals/`, written out by
hand and never regenerated.

What is being scored is the code that surrounds a reply — the parts of the app
that behave the same way every time, whatever model is on the other end:

| Probe | Module under test | What a failure means |
| --- | --- | --- |
| `answer-scoring` | `desktop/src/evals.js` | The Evals screen would grade a model's answer differently: a reasoning block no longer stripped, a fenced JSON reply no longer unwrapped, a task check changed. |
| `tool-calls` | `desktop/src/tools.js` | A streamed tool call is assembled wrong — arguments split across chunks, two calls interleaved by index, an object instead of a JSON string — or a dangerous tool stopped asking for approval. |
| `slash-routing` | `desktop/src/composer.js` | A `/command` or one of its aliases stopped routing, lost its argument, or stopped switching mode. |
| `fallback` | `desktop/src/fallback.js` | The ladder after a failed turn changed: the wrong model is tried next, or the app would silently switch a remote model the user picked. |
| `plan-queries` | `desktop/src/research.js` | A planning reply no longer yields searches — fenced JSON, JSON in prose, a bare list, the dedupe and the cap. |
| `citations` | `desktop/src/research.js` | Source numbering or citation handling changed: `[3]` must always be the third source in the printed list, an invented number must be stripped, a Markdown link must not be mistaken for a citation. |
| `prompt-assembly` | `desktop/src/research.js` | A rule went missing from a system prompt — "use ONLY the numbered sources", "do not write a references list", "do not invent sources". |
| `template` | `desktop/src/recipes.js` | `/recipe ...` selects the wrong recipe or fills the prompt wrong: a named value must beat a default, an unfilled placeholder must be reported rather than pasted as `{{topic}}`. |

The harness `require`s those modules directly. It never reimplements a rule, so
a case cannot pass against a copy of the behaviour it is checking — if the
module changes, the case changes verdict. (Proved in
`test/eval-harness.test.js`, which drives the score to 0% on purpose.)

Modules that only run in a browser are out of scope: anything under
`desktop/src/screens/` or `*.tsx` needs React and a DOM, so it is covered by the
unit tests and the Maestro/browser smokes instead. Everything scored here is a
UMD module that loads in plain node.

### Not the same thing as the Evals feature

The desktop app has an **Evals** screen (`desktop/src/evals.js`,
`desktop/src/screens/EvalsScreen.tsx`) that runs the same short tasks against
*your real models* and tells you which one does the job. That measures models.
This harness reuses that file's scoring code but feeds it fixtures, so it
measures the app. Both exist; they answer different questions.

## Determinism

The same commit must always produce the same score, on any machine:

- no network, no model, no clock-dependent behaviour;
- `process.env.TZ` is pinned to `UTC` at the top of the harness, because
  `research.js` formats dates in local time;
- every research case passes a fixed `date`;
- tool-call ids are deliberately **not** scored — `tools.finish` invents a
  random id when the provider sent none.

## The threshold

`evals/threshold.json`:

```json
{ "minPercent": 100 }
```

It started at the rate the suite passed on the day it landed, so the job was
green on its first run. Raising it is a one-line commit. Lowering it is also a
one-line commit, and should only ever record a gap somebody has written down —
say in the commit message which `NEURA-0xx` item closes it.

## Adding a case

1. Pick the probe whose module you want to pin down (the table above), and open
   the matching `evals/<probe>.jsonl`.
2. Add one line. The shape is always the same:

   ```json
   {"id": "a-sentence-about-the-behaviour", "probe": "slash-routing", "input": {"text": "/sh ls -la"}, "expect": {"command": "shell", "mode": "shell"}}
   ```

   - `id` is unique across the whole suite and reads like the claim it makes.
   - `input` is whatever the probe takes — a scripted reply, a stream, a typed
     line, a failure. The probe's source in `scripts/run-evals.js` is the
     reference; each one is a dozen lines.
   - `expect` is compared **key by key** against what the probe produced, so a
     case asserts only the fields it cares about and ignores the rest.
   - Lines starting with `//` and blank lines are ignored, so files can carry a
     header explaining what they pin down.
3. Run it:

   ```
   node scripts/run-evals.js --probe=slash-routing
   node scripts/run-evals.js --json          # the same run, machine-readable
   ```

4. Check it can fail. Change the expectation to something wrong and confirm the
   case goes red with a useful reason. A case that passes no matter what the app
   does is worse than no case.
5. `node --test test/eval-harness.test.js` — it checks ids are unique, every
   probe has cases, and the suite still clears the threshold.

Adding a probe (a new module worth scoring) means adding one function to
`PROBES` in `scripts/run-evals.js` and a `.jsonl` file next to the others. A
probe must not read `expect`; the comparison is the runner's job, and there is a
test that enforces it.
