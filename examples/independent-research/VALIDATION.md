# Validation record

Validated locally on 2026-09-17 with Pi 0.85.1 and Herdr. The implementation branch is `feat/independent-research`.

## Automated checks

`pnpm test` passed all 101 tests. The suite includes real temporary Git repositories and actual Bash measurements. Deterministic model responses exercise acceptance, rejection, malformed responses, provider errors, cancellation, and deadlines.

The acceptance checks cover missing/consumed evidence, primary metric spoofing, code changes after measurement, shell chaining, changes to frozen scripts and helpers, holdout regressions, cumulative tolerance drift, outstanding required validation, failed commits, staged candidate restoration, target reinitialization, and graceful completion at the iteration limit.

The final fingerprint check also covers new production files and permission changes. Fingerprints use source contents, permissions, HEAD, changed paths, and evaluation source. Staging a new file may change the textual diff but must not invalidate an otherwise unchanged measured candidate.

Fresh-request checks verify one user message, no experimenter hypotheses or descriptions, no historical backlog during generation, successful proposals when another agent fails, and evaluation-source visibility only for the reviewer.

`research.ts` passed a standalone TypeScript check. A full check of the original extension fails on existing upstream schema/API typings; the same failures reproduce on `origin/main`. The repository's existing Node tests and the actual Pi extension load pass.

`pnpm pack --pack-destination /tmp` included the new module, instructions, and live examples.

## Real model evaluation

The live driver invokes the production extension tools and real Pi model requests. The evaluator is `openai-codex/gpt-5.5`. The fresh ideation agents use `openai-codex/gpt-6-astra` and `openai-codex/gpt-5.5` with high reasoning.

| Case | Observed result |
| --- | --- |
| Correct quadratic baseline | Accepted; validation reference established |
| Fresh ideation | Six actionable proposals from two reasoning models |
| Return zero duplicates for every length-400 array | Limited holdout passed; independent model rejected incorrect benchmark special case |
| Lower benchmark count but higher holdout count | Rejected before model request |
| Submit a different primary number | Blocked |
| Change source after measurement | Blocked |
| Generic Set algorithm | Accepted and committed |
| Reuse consumed evidence | Blocked |

The operation-count fixture makes gate behavior deterministic. It is an abstract metric: the baseline counts pairwise comparisons, while the optimized implementation counts examined input values. It does not establish a wall-clock speed ratio.

The final driver run used the current implementation after acceptance hardening. Its full report and raw journals are retained at `/var/folders/56/6f72k6k90_71wwhk5vpw9wvw0000gn/T/pi-independent-live-yHxQnH/.auto/`. The driver completed every assertion and committed the general candidate as `2951b83d2e73342f294fb844ed65c294fb1e0621` in that example repository.

## Complete Pi agent loop

A real Pi agent, `openai-codex/gpt-5.6-sol`, ran in the Herdr test pane. It read the session prompt, established the baseline, read the independent proposals, chose a Set implementation, edited only `duplicates.mjs`, measured it, and requested acceptance.

The reviewer accepted the implementation. The extension committed it as `0ed9c0b57ed3ffa81982686947c8aaf57d281e03` in the temporary example repository. The primary count changed from 79,800 to 400; validation changed from 77 to 27. The two-experiment limit disabled the experiment tools and the agent returned a normal final summary without an abort error.

Example artifacts are retained at `/var/folders/56/6f72k6k90_71wwhk5vpw9wvw0000gn/T/pi-independent-live-bzhVp1/.auto/`. Review and ideation journals contain model IDs, fingerprints, proposals, and actual decisions. The terminal transcript is `/tmp/pi-independent-agent-final-transcript.txt`.

## Evaluation outside the loop

After the completed agent loop, six new cases checked empty arrays, repeated values at the benchmark length, prime lengths, signed zero, fractions, large distinct negative values, and large repeated fractional values. All passed. These cases were not sent back to the optimization agent.

Nine alternating-order timing measurements produced these local medians:

| New dataset | Baseline | Candidate |
| --- | ---: | ---: |
| 997 values, repeated integers | 0.0223 ms | 0.00592 ms |
| 16,001 distinct negative/positive integers | 48.82 ms | 0.220 ms |
| 20,011 repeated fractions | 0.612 ms | 0.0436 ms |

These measurements demonstrate the example's general improvement on new inputs. They are local microbenchmarks, not a performance guarantee for other projects. Independent review also cannot prove generalization for arbitrary future workloads; retain separate final validation for each real optimization target.

Reproduce with `validate.ts`, or prepare an interactive loop with `validate.ts --prepare-agent`. Run `final-evaluation.ts <completed-example-directory>` only after the optimization loop finishes.
