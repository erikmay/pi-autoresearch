# Independent review and an outside advisor

Independent mode adds two outside authorities to the experiment loop. Both use `openai-codex/gpt-6-astra`; the experimenter model must differ.

- A reviewer checks each candidate `keep` against frozen evidence before it is committed.
- An advisor is consulted at turning points. It proposes genuinely new approaches or tells the loop to stop.

Enable it with `.auto/research.json`. Sessions without this file keep their usual behavior.

## Setup

Create the usual `.auto/measure.sh`, then create `.auto/holdout.sh`. The holdout script must check correctness on inputs different from the optimization benchmark, exit nonzero on failure, and emit each configured validation metric exactly once as `METRIC name=number`.

```json
{
  "objective": "Reduce parser execution time across representative inputs.",
  "constraints": [
    "Preserve parser results on all valid inputs.",
    "Do not special-case benchmark fixtures."
  ],
  "sourceFiles": ["src/parser.ts"],
  "evaluationFiles": [".auto/measure.ts", ".auto/holdout.ts", "fixtures/validation.json"],
  "validationMetrics": [
    { "name": "validation_ms", "direction": "lower", "maxRegressionPercent": 2 }
  ],
  "repetitions": 3,
  "approachBudget": 3,
  "timeoutSeconds": 180
}
```

`sourceFiles` contains the production source the agent may change and all source needed for review. Changes to other production files block the experiment. `evaluationFiles` contains helper scripts and data used by measurement or validation. Include every such dependency: freezing a shell wrapper does not freeze a helper it imports. Evaluation files must not overlap production source files.

`approachBudget` is the number of failed experiments in a row that close one approach (default 3). Unknown keys are ignored.

Run the benchmark as `bash .auto/measure.sh`. Independent mode executes this script directly and rejects arguments, environment prefixes, pipes, redirection, and chained commands.

Start the session with `/autoresearch <goal>`. `/autoresearch ideas` consults the advisor on demand. API calls use Pi's configured providers and authentication.

## Approaches

Every `run_experiment` names its approach: a short kebab-case name for the idea family the experiment belongs to, for example `field-order`. The unchanged baseline uses `baseline`. Variants of one idea share one name.

An approach closes after `approachBudget` failed experiments in a row. A closed approach is rejected before the benchmark runs. This is what ends an idea that stopped paying off: the experimenter cannot keep tuning it. The system prompt tells the agent not to rename an exhausted idea.

Approach counters live in `.auto/research-state.json` and survive restarts. Every log entry records its approach in `asi.approach`.

## Acceptance

The first accepted run establishes the baseline. When the source has no changes against HEAD, the baseline needs measured evidence and a passing holdout but no model review.

Later candidates must improve the primary metric over the best accepted run. Validation runs repeat independently and report the median of each metric. A regression beyond its tolerance rejects the candidate before a model request. Validation is compared with both the last accepted result and the original baseline, so small tolerated regressions cannot accumulate.

Only then does the reviewer see the candidate. It receives the objective, constraints, source snapshot, code diff, frozen evaluation files, captured benchmark output, checks evidence, and validation evidence. It does not receive the experimenter's descriptions, hypotheses, or conversation messages. Each request starts with a fresh message array and no tools.

A rejection converts the proposed `keep` into `discard` and restores the production source and Git index. Missing validation, provider errors, timeouts, invalid JSON, incomplete responses, or outstanding required validation cannot produce acceptance. Changed source, changed evaluation scripts, fabricated logged metrics, and reuse of consumed evidence block acceptance. When `.auto/checks.sh` exists, failed or missing checks evidence blocks acceptance.

## Advisor

The advisor is consulted:

- once after the baseline,
- whenever an approach closes,
- after every `approachBudget` failed experiments in a row across approaches.

It receives the objective, constraints, current source, and the list of open and closed approach names with attempt and keep counts. It never receives the log, the ideas backlog, holdout outputs, or conversation history.

It returns one of two verdicts. `continue` comes with three to five approaches that do not overlap with any listed one; the extension appends them as `- [ ] Approach: <name> | ...` lines to `.auto/ideas.md` and drops proposals whose name is already known. `stop` ends the loop with a reason. This is the only planned stop in independent mode: there is no iteration cap unless `.auto/config.json` sets one.

Malformed JSON gets one fresh bounded retry. Advisor failures leave the loop running and are reported in the tool result.

## Evidence and limits

`.auto/reviews.jsonl` records reviewer decisions and measured evidence. `.auto/ideation.jsonl` records each advisor consultation with the approach summary, verdict, reason, and proposals. `asi.independent_review` links each reviewed experiment to its evidence ID and source fingerprint.

An independent model can detect correctness gaps and benchmark special cases missed by a small validation set. It cannot prove generalization. Keep a separate final evaluation dataset outside the loop and evaluate the final candidate once before accepting the overall result.

Isolation here means separate model requests with no conversation history and no model tools. It is not an operating-system sandbox for the experimenter. Do not treat the model as a security boundary against a hostile process with filesystem access.

The complete source and evaluation snapshot must fit within 200 KiB. Benchmark output, each validation output, and model responses must fit within 32 KiB. Oversized evidence blocks acceptance rather than silently truncating the review. The timeout applies to each model request and validation invocation.

The research contract and accepted validation reference survive restarts in `.auto/research-state.json`. `off` cancels research requests and keeps the saved reference. To change the objective, metric, scope, or evaluation rules, stop the loop, archive `.auto`, and create a new session.

## Run the live example

The example makes real model requests and retains its temporary repository and reports:

```sh
pnpm install --frozen-lockfile
bun examples/independent-research/validate.ts
```

Override the executing model with `RESEARCH_EXPERIMENTER`. For a complete interactive loop, run `bun examples/independent-research/validate.ts --prepare-agent`, start Pi in the printed directory with this extension and its skills loaded, then run `/autoresearch optimize generic duplicate counting`. The loop runs until the advisor stops it.

After the loop, run `bun examples/independent-research/final-evaluation.ts <example-directory>` to check new input distributions outside the loop.
