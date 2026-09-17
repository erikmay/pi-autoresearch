# Validation record

Validated locally on 2026-09-17 for the simplified outside advisor on `feat/independent-research`.

## Automated checks

`pnpm test` passed all 88 tests. Existing research checks were adapted to the advisor-only behavior. Tests for the removed model reviewer and holdout-reference state were removed.

The checks cover measured metric binding, consumed evidence, source changes, canonical benchmark execution, protected scripts and helpers, correctness failures, failed commits, new source files, permission changes, and configured experiment limits.

Advisor checks cover measured result history, useful variants of previous approaches, fresh context without conversation or experimenter claims, provider errors, cancellation, timeouts, and oversized responses. Integration checks cover automatic advice after correctness failures across approaches and a manual advisor stop that disables the experiment tools without aborting the agent's final response.

`git diff --check` passed.

## Real advisor requests

The live driver invoked the production extension tools and made two real requests to `openai-codex/gpt-6-astra`. It supplied an experimenter identity of `openai-codex/gpt-5.6-sol`. The driver controls the experiments; this was not a new complete interactive agent-loop run.

| Case | Observed result |
| --- | --- |
| Keep without measurement | Blocked |
| Correct quadratic baseline | Kept; advisor proposed a hash-set approach |
| Return zero duplicates for every length-400 array | Correctness checks failed; candidate restored |
| Submit a different primary number | Blocked |
| Change source after measurement | Blocked |
| Generic Set algorithm | Kept and committed without a model reviewer |
| Reuse the accepted result | Blocked |
| Manual advice after the improvement | Advisor returned stop; experiment tools disabled |

The example primary metric fell from 79,800 pairwise comparisons to 400 examined values. This operation count demonstrates gate behavior and algorithmic work; it does not establish a wall-clock speed ratio.

Artifacts are retained at `/var/folders/56/6f72k6k90_71wwhk5vpw9wvw0000gn/T/pi-independent-live-ISC9AT/.auto/`. The accepted example commit is `75263983de1ddcfa101e84d15195d915646fdeb3`. `live-report.json`, `ideation.jsonl`, and `log.jsonl` record the requests, decisions, and measurements.

## Evaluation outside the loop

`final-evaluation.ts` passed all six correctness cases after the driver finished. It also measured nine alternating-order timing samples per larger dataset.

| Dataset | Baseline median | Candidate median |
| --- | ---: | ---: |
| 997 values, repeated integers | 0.0252 ms | 0.00546 ms |
| 16,001 distinct negative/positive integers | 50.11 ms | 0.191 ms |
| 20,011 repeated fractions | 0.638 ms | 0.0458 ms |

These are local microbenchmarks. The report is retained in `final-evaluation.json`. Final evaluation results were not returned to the advisor or optimization loop.

## Reproduction

Run `bun examples/independent-research/validate.ts` for the scripted validation with real advisor requests. Run it with `--prepare-agent` to prepare an interactive Pi loop. After completion, run `bun examples/independent-research/final-evaluation.ts <example-directory>`.

Earlier validation notes in commit `09e3d95` describe the former mandatory reviewer and holdout engine. Those notes are historical evidence for that implementation, not validation of the current advisor-only agent loop.
