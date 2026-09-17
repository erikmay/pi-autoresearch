# Independent review and fresh ideation

Independent mode adds two authorities to the experiment loop:

- A separate reasoning model reviews candidates before `keep` can commit them.
- Parallel ideation agents propose experiments from fresh requests without the experiment history.

Enable it with `.auto/research.json`. Existing sessions without this file retain their usual behavior.

## Setup

Create the usual `.auto/measure.sh`, then create `.auto/holdout.sh`. The holdout script must check correctness on inputs different from the optimization benchmark, exit nonzero on failure, and emit each configured validation metric exactly once as `METRIC name=number`.

Use explicit reasoning model IDs available in your Pi installation. The reviewer model must differ from the active experimenter model. For example, when the experimenter uses `openai-codex/gpt-5.6-sol`:

```json
{
  "objective": "Reduce parser execution time across representative inputs.",
  "constraints": [
    "Preserve parser results on all valid inputs.",
    "Do not special-case benchmark fixtures."
  ],
  "sourceFiles": ["src/parser.ts"],
  "evaluationFiles": [".auto/measure.ts", ".auto/holdout.ts", "fixtures/validation.json"],
  "reviewModel": "openai-codex/gpt-5.5",
  "ideaModels": ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.5"],
  "validationMetrics": [
    { "name": "validation_ms", "direction": "lower", "maxRegressionPercent": 2 }
  ],
  "repetitions": 3,
  "ideaInterval": 5,
  "stagnationThreshold": 3,
  "timeoutSeconds": 180
}
```

Replace the file paths and models with your own. `sourceFiles` contains the production source the agent may change and all source needed for review. Changes to other production files block the experiment. `evaluationFiles` contains helper scripts and data used by measurement or validation. Include every such dependency: freezing a shell wrapper does not freeze a helper it imports. Evaluation files must not overlap production source files.

Run the benchmark as `bash .auto/measure.sh`. Independent mode executes this script directly and rejects arguments, environment prefixes, pipes, redirection, and chained commands.

Start the session with `/autoresearch <goal>`. The usual initialization and baseline flow applies. `/autoresearch ideas` requests fresh ideas on demand. API calls use Pi's configured providers and authentication; no extra CLI or credentials file is required.

## Acceptance

The first accepted run establishes a baseline. Later candidates must improve the primary metric over the best accepted run. Validation runs repeat independently and report the median of each metric. A regression beyond its configured tolerance rejects the candidate before a model request. Validation is compared with both the last accepted result and the original baseline, so small tolerated regressions cannot accumulate beyond the baseline tolerance.

The reviewer receives only the objective, constraints, source snapshot, code diff, frozen evaluation files, captured benchmark output, and validation evidence. It does not receive the experimenter's descriptions, hypotheses, previous suggestions, or conversation messages. Each request starts with a fresh message array and no tools.

A model rejection converts a proposed `keep` into `discard` and restores the production source and Git index. Missing validation, provider errors, timeouts, invalid JSON, incomplete responses, or outstanding required validation cannot produce acceptance. Changed source, changed evaluation scripts, fabricated logged metrics, and reuse of consumed evidence block acceptance.

The research contract and accepted validation reference survive restarts in `.auto/research-state.json`. An active session checks these files against its captured values. `off` cancels research requests; it keeps the saved reference. `clear` deletes the experiment log but also keeps this reference. To change the objective, metric, scope, or evaluation rules, stop the loop and create a new session explicitly. Archive the existing `.auto` directory and set up new session files.

## Ideation

Idea agents have separate roles: algorithm design, alternative approaches, and bottleneck analysis. They receive the objective, constraints, and current production source. They receive no backlog, discarded hypotheses, validation outputs, or conversation history.

Ideation runs after the baseline, at the configured interval, and when the discard/crash streak first reaches the stagnation threshold. Successful proposals survive another agent's failure. Each proposal records its hypothesis, concrete change, mechanism, validation plan, and model.

The extension removes exact repeated proposals before appending Markdown checkboxes to `.auto/ideas.md`. The experimenter then compares the new candidates with earlier runs. Semantic duplicate detection is not automatic. Mark completed ideas and record why an earlier failure is or is not relevant to the current source.

## Evidence and limits

`.auto/reviews.jsonl` records reviewer decisions and measured evidence. `.auto/ideation.jsonl` records proposals, model IDs, and agent failures. `asi.independent_review` links each reviewed experiment to its evidence ID and source fingerprint.

An independent model can detect correctness gaps and benchmark special cases missed by a small validation set. It cannot prove generalization. Repeatedly consulted validation data can itself become an optimization target. Keep a separate final evaluation dataset outside the loop and evaluate the final candidate once before accepting the overall result. The plugin's confidence display remains an advisory heuristic; it is not a statistical acceptance test.

Isolation here means separate model requests with no conversation history and no model tools. It is not an operating-system sandbox for the experimenter. Review quality depends on representative validation data, adequate source scope, and complete `evaluationFiles`. Do not treat the model as a security boundary against a deliberately hostile process with filesystem access.

The complete source and evaluation snapshot must fit within 200 KiB. Benchmark output, each validation output, and model responses must fit within 32 KiB. Oversized evidence blocks acceptance rather than silently truncating the review. Timeout applies to each model request and validation invocation.

## Run the live example

The example makes real model requests and retains its temporary repository and reports:

```sh
pnpm install --frozen-lockfile
bun examples/independent-research/validate.ts
```

It checks a correct baseline, fresh intelligent ideation, a benchmark shortcut that passes the limited holdout but fails independent review, a deterministic validation regression, metric spoofing, edits after measurement, and a general algorithm improvement that gets committed. It uses operation counts to make acceptance boundaries deterministic; those counts are not wall-clock speed measurements.

Override models with `RESEARCH_EXPERIMENTER`, `RESEARCH_REVIEWER`, and the comma-separated `RESEARCH_IDEA_MODELS`. The live example uses the installed current Pi SDK. Automated tests use temporary Git repositories and deterministic model responses for failure cases.

For a complete interactive agent loop, run `bun examples/independent-research/validate.ts --prepare-agent`. Start Pi in the printed directory with this extension loaded, then run `/autoresearch optimize generic duplicate counting`. Pi establishes the baseline, chooses an independently generated idea, implements it, and requests acceptance. The two-experiment limit lets it report the final result without an abort error.

After the loop, run `bun examples/independent-research/final-evaluation.ts <example-directory>`. This checks new input distributions and reports baseline/candidate wall-clock medians across nine alternating-order measurements. These final cases are not sent back to the optimization loop.
