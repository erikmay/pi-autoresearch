# Outside research advisor

The research agent runs experiments. A separate advisor helps it choose useful directions and decide when to stop. The advisor uses `openai-codex/gpt-6-astra`; the experimenter model must differ.

Enable the advisor with `.auto/research.json`. Sessions without this file keep their usual behavior.

## Setup

Create the usual `.auto/measure.sh` and put correctness checks in `.auto/checks.sh`. Then add:

```json
{
  "objective": "Reduce parser execution time across representative inputs.",
  "constraints": [
    "Preserve parser results on all valid inputs.",
    "Do not special-case benchmark fixtures."
  ],
  "sourceFiles": ["src/parser.ts"],
  "evaluationFiles": [".auto/measure.ts", ".auto/checks.ts", "fixtures/validation.json"],
  "failureInterval": 3,
  "timeoutSeconds": 180
}
```

`sourceFiles` lists the production files the agent may change and the source the advisor needs. Changes to other production files block measurement. `evaluationFiles` lists benchmark and correctness-check helpers and data. Include their dependencies; freezing a shell wrapper does not freeze imported helpers. Source files and evaluation files must not overlap.

Configuration, measurement scripts, correctness scripts, and listed evaluation files stay fixed while the research session is active. Stop the loop before changing them.

Run the benchmark as `bash .auto/measure.sh`. Advisor mode executes this script directly and rejects arguments, environment prefixes, pipes, redirection, and chained commands. The primary metric must appear exactly once as `METRIC name=number`.

If validation inside the benchmark rejects a candidate, print `VALIDATION_FAILED <reason>` on its own line and exit nonzero. The extension records this as `checks_failed`, even if the experimenter proposes `crash`. Other nonzero benchmark exits remain crashes. Skipped checks after a failed benchmark are expected; the actual benchmark output is captured as the failure reason. Timeouts remain benchmark failures even if earlier output contains a validation marker.

Keep stderr and failure diagnostics visible in `.auto/checks.sh`. Redirecting build output to `/dev/null` can hide compiler or lint errors from both the experimenter and advisor.

Start with `/autoresearch <goal>`. Use `/autoresearch ideas` to ask for advice on demand. Requests use Pi's configured providers and authentication.

## Advice

The advisor is consulted after the first accepted baseline, after every `failureInterval` unsuccessful experiments in a row, and on manual request. The default interval is three. Discards, crashes, and failed correctness checks all count. A keep resets the failure streak.

Each request starts fresh with no conversation history and no model tools. The advisor receives:

- The objective, constraints, and current source.
- The primary metric, direction, baseline, and best accepted result.
- Baseline and best accepted outcomes with secondary metrics captured directly from benchmark `METRIC` lines. Agent-supplied secondary log values are not used as measured advisor evidence. Older outcomes without captured secondary metrics leave those values unknown.
- Attempt counts, keep counts, best accepted metric, and latest result for each approach.
- The last 20 experiment outcomes with captured metrics, correctness-check results, and actual failure diagnostics. Failed validation remains evidence against an approach even when no timing was produced.

It does not receive the experimenter's hypotheses, self-evaluation, conversation, ideas backlog, or evaluation source. Independence comes from a fresh request, while measured outcomes provide the information needed for useful advice.

The advisor weighs primary gains against measured secondary costs and added source complexity. Meeting a hard constraint does not make a tradeoff worthwhile. A small gain with a large latency increase can justify stopping; a specific proposal to remove that cost can justify continuing. Missing secondary evidence must remain explicit uncertainty.

Use an optional short kebab-case `approach` name in `run_experiment`, such as `field-order`. Variants should share a name. Missing names use `unspecified`. Names serve as memory; no approach is locked. The advisor can suggest a useful variant of a previous idea.

`continue` returns one to three concrete suggestions with a hypothesis, change, mechanism, and validation plan. The extension appends them to `.auto/ideas.md`. `stop` disables the experiment tools and automatic continuation, whether requested automatically or through `/autoresearch ideas`. The agent can then report the accepted result.

Malformed JSON gets one fresh bounded retry. Provider errors, timeouts, and invalid responses are reported and leave the loop running. `timeoutSeconds` applies to each advisor request. Use `.auto/config.json` with `maxIterations` if a hard experiment limit is needed. Advisor mode does not use the usual 200-turn or consecutive-discard auto-resume limits.

## Acceptance and records

There is no model review for each keep and no separate holdout-reference state. A keep requires fresh measured evidence, an unchanged source snapshot, passing correctness checks when `.auto/checks.sh` exists, and a primary improvement over the best accepted run. The baseline only needs fresh successful measurement. Claimed metrics cannot replace captured values, and consumed measurements cannot be reused.

Keeps commit the measured candidate. Discards, crashes, and correctness failures restore production source and the Git index. A failed restore stops advisor mode instead of continuing with rejected code.

The usual `.auto/log.jsonl` records approach names and captured evidence in `asi.research_measurement`. It also restores experiment history after restart. `.auto/ideation.jsonl` records advisor inputs and decisions. No extra research-state file is required.

Older `approachBudget`, `validationMetrics`, and `repetitions` settings are no longer used. Move any required `.auto/holdout.sh` checks into `.auto/checks.sh` and set `failureInterval` for advice frequency. Old review journals and research-state files are historical records and are not read.

The advisor is guidance, not a correctness proof or a filesystem sandbox. Use representative correctness checks during research and a separate final evaluation before accepting the overall result. Source plus advisor history must fit within 200 KiB; benchmark output and advisor responses must fit within 32 KiB.

## Example

```sh
pnpm install --frozen-lockfile
bun examples/independent-research/validate.ts
```

This driver uses real advisor requests and preserves its temporary repository and reports. Set `RESEARCH_EXPERIMENTER` to change the executing model.

For an interactive loop, run `bun examples/independent-research/validate.ts --prepare-agent`, start Pi in the printed directory with this extension and its skills loaded, then run `/autoresearch optimize generic duplicate counting`.

After the loop, run `bun examples/independent-research/final-evaluation.ts <example-directory>` to evaluate correctness and timing on additional input distributions outside the optimization loop.
