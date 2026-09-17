/** Evaluate the completed duplicate-counting example on new inputs, outside the optimization loop. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const cwd = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun examples/independent-research/final-evaluation.ts <completed-example-directory>");
function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
const baselineCommit = git(["rev-list", "--max-parents=0", "HEAD"]);
const baselineCode = git(["show", `${baselineCommit}:duplicates.mjs`]);
const baseline = (await import("data:text/javascript;base64," + Buffer.from(baselineCode).toString("base64"))).duplicates;
const candidate = (await import(pathToFileURL(path.join(cwd, "duplicates.mjs")).href)).duplicates;
const cases = [
  { name: "empty", input: [], expected: 0 },
  { name: "benchmark-length-all-equal", input: Array(400).fill(-1.5), expected: 399 },
  { name: "prime-length-repeated", input: Array.from({ length: 997 }, (_, i) => i % 100), expected: 897 },
  { name: "signed-zero-and-fractions", input: [0, -0, 1.25, 1.25, -2, -2], expected: 3 },
  { name: "large-distinct-negatives", input: Array.from({ length: 16001 }, (_, i) => i - 8000), expected: 0 },
  { name: "large-repeated-fractions", input: Array.from({ length: 20011 }, (_, i) => (i % 127 - 63) / 4), expected: 19884 },
];
for (const c of cases) {
  assert.equal(baseline(c.input).duplicates, c.expected);
  assert.equal(candidate(c.input).duplicates, c.expected);
}
function time(fn: typeof candidate, input: number[], expected: number): number {
  const started = performance.now();
  const result = fn(input);
  const duration = performance.now() - started;
  assert.equal(result.duplicates, expected);
  return duration;
}
function median(samples: number[]): number {
  return samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)];
}
const timings = cases.filter((c) => c.input.length >= 997).map((c) => {
  for (let i = 0; i < 3; i++) { baseline(c.input); candidate(c.input); }
  const old: number[] = [], current: number[] = [];
  for (let i = 0; i < 9; i++) {
    // Alternate order so one implementation does not always run first.
    if (i % 2) { current.push(time(candidate, c.input, c.expected)); old.push(time(baseline, c.input, c.expected)); }
    else { old.push(time(baseline, c.input, c.expected)); current.push(time(candidate, c.input, c.expected)); }
  }
  return { name: c.name, size: c.input.length, baselineMedianMs: median(old), candidateMedianMs: median(current) };
});
const report = { commit: git(["rev-parse", "HEAD"]), correctnessPassed: true, caseCount: cases.length, cases: cases.map((c) => ({ name: c.name, size: c.input.length, expected: c.expected })), timings };
fs.writeFileSync(path.join(cwd, ".auto/final-evaluation.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
