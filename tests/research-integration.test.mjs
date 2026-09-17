import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import autoresearch from "../extensions/pi-autoresearch/index.ts";

function exec(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") { reject(error); return; }
      resolve({ code: error?.code ?? 0, stdout, stderr, killed: error?.killed ?? false });
    });
  });
}

async function harness(t, maxIterations = 10, extraSources = []) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-integration-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".auto"));
  const write = (name, value) => fs.writeFileSync(path.join(cwd, name), value);
  write(".gitignore", ".auto/\n");
  write("source.sh", "PRIMARY=100\nHOLDOUT=100\n");
  write(".auto/measure.sh", '. ./source.sh\nif test "${RECOGNITION:-pass}" = fail; then printf "VALIDATION_FAILED baseline code lost\\n"; exit 1; fi\nprintf "METRIC time=%s\\n" "$PRIMARY"\n');
  write(".auto/checks.sh", '. ./source.sh\ntest "$HOLDOUT" -le 100\n');
  write(".auto/config.json", JSON.stringify({ maxIterations }));
  write(".auto/research.json", JSON.stringify({ objective: "Improve generic execution time.", sourceFiles: ["source.sh", ...extraSources], failureInterval: 2 }));
  for (const args of [["init", "-q"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Research Test"], ["add", "."], ["commit", "-qm", "Baseline"]]) {
    assert.equal((await exec("git", args, { cwd })).code, 0);
  }
  const tools = new Map();
  const commands = new Map();
  const calls = [];
  let active = [];
  let decision = true;
  let failCommit = false;
  let abortCount = 0;
  const ctx = {
    cwd, hasUI: false, mode: "rpc", isIdle: () => true, hasPendingMessages: () => false,
    model: { provider: "fake", id: "experimenter" },
    modelRegistry: {
      find: (provider, id) => ({ provider, id, reasoning: true }),
      async complete(model, context) {
        calls.push({ model: `${model.provider}/${model.id}`, context });
        const response = !decision
          ? { verdict: "stop", reason: "No useful direction remains.", ideas: [] }
          : { verdict: "continue", reason: "Untried directions remain.", ideas: [{ approach: "stable-value-cache", hypothesis: "Remove work", change: "Cache stable values", mechanism: "Avoid repeated reads", validation: "Compare varied inputs" }] };
        return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(response) }] };
      },
    },
    abort() { abortCount++; }, sessionManager: { getSessionId: () => cwd, getBranch: () => [] },
    ui: { setWidget() {}, notify() {} },
  };
  autoresearch({
    on() {}, appendEntry() {}, registerShortcut() {},
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    getActiveTools: () => active, setActiveTools: (next) => { active = next; }, sendUserMessage() {},
    exec: (command, args, options) => failCommit && command === "git" && args[0] === "commit"
      ? Promise.resolve({ code: 1, stdout: "", stderr: "Commit hook failed" }) : exec(command, args, options),
  });
  const run = (approach = "baseline") => tools.get("run_experiment").execute("run", { command: "bash .auto/measure.sh", approach }, undefined, undefined, ctx);
  const log = (metric, status = "keep", extra = {}) => tools.get("log_experiment").execute("log", { commit: "abcdef0", metric, status, description: "EXPERIMENTER_CLAIM_DO_NOT_SEND", asi: { hypothesis: "HISTORY_DO_NOT_SEND" }, ...extra }, undefined, undefined, ctx);
  await tools.get("init_experiment").execute("init", { name: "Optimize time", metric_name: "time", direction: "lower" }, undefined, undefined, ctx);
  return { cwd, ctx, calls, write, run, log, commands, tools, abortCount: () => abortCount, activeTools: () => active, reject: () => { decision = false; }, failCommit: () => { failCommit = true; }, allowCommit: () => { failCommit = false; } };
}

test("measured acceptance commits actual code and the manual advisor can stop the loop", async (t) => {
  const f = await harness(t);
  await f.run();
  const baseline = await f.log(100);
  assert.equal(baseline.details.experiment.status, "keep");
  assert.ok(f.calls.some((c) => c.context.systemPrompt.includes("research advisor")));
  assert.equal(f.calls.some((c) => c.context.systemPrompt.includes("evaluator")), false, "Acceptance needs no reviewer.");
  assert.ok(f.calls.every((c) => c.model === "openai-codex/gpt-6-astra"));
  f.write("source.sh", "PRIMARY=50\nHOLDOUT=50\n");
  await f.run();
  const result = await f.log(50);
  assert.equal(result.details.experiment.status, "keep");
  assert.equal((await exec("git", ["show", "HEAD:source.sh"], { cwd: f.cwd })).stdout, "PRIMARY=50\nHOLDOUT=50\n");
  for (const c of f.calls) {
    assert.equal(JSON.stringify(c.context).includes("EXPERIMENTER_CLAIM_DO_NOT_SEND"), false);
    assert.equal(JSON.stringify(c.context).includes("HISTORY_DO_NOT_SEND"), false);
    assert.equal(c.context.messages.length, 1);
  }
  assert.equal(f.calls.length, 1);
  f.reject();
  await f.commands.get("autoresearch").handler("ideas", f.ctx);
  assert.equal(f.activeTools().includes("run_experiment"), false);
  assert.equal(f.abortCount(), 0);
  assert.equal((await f.log(50)).isError, true);
});

test("correctness failures revert candidates and trigger advisor guidance across approaches", async (t) => {
  const f = await harness(t);
  await f.run(); await f.log(100);
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.cwd })).stdout;
  f.write("source.sh", "PRIMARY=1\nHOLDOUT=110\n");
  await f.run("first-idea");
  assert.match((await f.log(1)).content[0].text, /Cannot keep/);
  const rejected = await f.log(1, "checks_failed");
  assert.equal(rejected.details.experiment.status, "checks_failed");
  f.reject();
  f.write("source.sh", "PRIMARY=1\nHOLDOUT=100\nRECOGNITION=fail\n");
  await exec("git", ["add", "source.sh"], { cwd: f.cwd });
  const validation = await f.run("second-idea");
  assert.equal(validation.details.validationFailed, true);
  assert.equal(validation.details.crashed, false);
  const stopped = await f.log(0, "crash");
  assert.equal(stopped.details.experiment.status, "checks_failed");
  const history = JSON.parse(f.calls.at(-1).context.messages[0].content).recentResults;
  assert.match(history.at(-1).failure, /baseline code lost/);
  assert.equal(history.at(-1).checksPassed, null);
  assert.equal(f.calls.length, 2);
  assert.equal(f.activeTools().includes("run_experiment"), false);
  assert.match(stopped.content[0].text, /STOP the experiment loop/);
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: f.cwd })).stdout, head);
  assert.equal(fs.readFileSync(path.join(f.cwd, "source.sh"), "utf8"), "PRIMARY=100\nHOLDOUT=100\n");
  assert.equal((await exec("git", ["diff", "--cached", "--name-only"], { cwd: f.cwd })).stdout, "");
});

test("spoofed metrics, stale code, changed contract, and matching advisor model block acceptance", async (t) => {
  const f = await harness(t);
  assert.equal((await f.log(1)).isError, true);
  await f.run();
  assert.equal((await f.log(1)).isError, true);
  f.write("source.sh", "PRIMARY=90\nHOLDOUT=90\n");
  assert.equal((await f.log(100)).isError, true);
  await f.run();
  f.ctx.model = { provider: "openai-codex", id: "gpt-6-astra" };
  assert.equal((await f.log(90)).isError, true);
  f.ctx.model = { provider: "fake", id: "experimenter" };
  f.write(".auto/research.json", "{}");
  assert.equal((await f.log(90)).isError, true);
  assert.equal(fs.readFileSync(path.join(f.cwd, ".auto/log.jsonl"), "utf8").split("\n").filter(Boolean).length, 1);
});

test("failed Git commits do not record keep and allow a retry", async (t) => {
  const f = await harness(t);
  await f.run(); await f.log(100);
  f.write("source.sh", "PRIMARY=50\nHOLDOUT=50\n");
  await f.run(); f.failCommit();
  assert.equal((await f.log(50)).isError, true);
  assert.equal(fs.readFileSync(path.join(f.cwd, ".auto/log.jsonl"), "utf8").trim().split("\n").length, 2);
  f.allowCommit();
  assert.equal((await f.log(50)).details.experiment.status, "keep");
});

test("shell chaining cannot replace canonical benchmark output", async (t) => {
  const f = await harness(t);
  for (const command of ["bash .auto/measure.sh >/dev/null; echo 'METRIC time=1'", "bash /tmp/other/.auto/measure.sh", "bash .auto/measure.sh --fake", "PRIMARY=1 bash .auto/measure.sh"]) {
    const result = await f.tools.get("run_experiment").execute("spoof", { command, approach: "spoof" }, undefined, undefined, f.ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /canonical benchmark/);
  }
  assert.equal((await f.log(1)).isError, true);
});

test("reinitialization invalidates pending evidence and cannot reset an accepted baseline", async (t) => {
  const f = await harness(t);
  await f.run();
  await f.tools.get("init_experiment").execute("init-again", { name: "Time", metric_name: "time", direction: "lower" }, undefined, undefined, f.ctx);
  assert.equal((await f.log(100)).isError, true);
  await f.run(); await f.log(100);
  const reinit = await f.tools.get("init_experiment").execute("reset", { name: "Other", metric_name: "other", direction: "higher" }, undefined, undefined, f.ctx);
  assert.equal(reinit.isError, true);
});

test("a worse primary cannot be kept even with passing correctness checks", async (t) => {
  const f = await harness(t);
  await f.run(); await f.log(100);
  f.write("source.sh", "PRIMARY=110\nHOLDOUT=100\n");
  await f.run();
  const calls = f.calls.length;
  assert.equal((await f.log(110)).isError, true);
  assert.equal(f.calls.length, calls);
});

test("iteration limit returns the accepted result and disables tools without aborting the turn", async (t) => {
  const f = await harness(t, 2);
  await f.run(); await f.log(100);
  f.write("source.sh", "PRIMARY=50\nHOLDOUT=50\n");
  await f.run();
  const result = await f.log(50);
  assert.equal(result.details.experiment.status, "keep");
  assert.match(result.content[0].text, /Maximum experiments reached/);
  assert.equal(f.abortCount(), 0);
  assert.equal(f.activeTools().includes("run_experiment"), false);
});

test("new source files can be staged and committed without invalidating measured code", async (t) => {
  const f = await harness(t, 10, ["extra.sh"]);
  await f.run(); await f.log(100);
  f.write("extra.sh", "PRIMARY=50\n");
  f.write("source.sh", ". ./extra.sh\nHOLDOUT=50\n");
  await f.run();
  const result = await f.log(50);
  assert.equal(result.details.experiment.status, "keep");
  assert.equal((await exec("git", ["show", "HEAD:extra.sh"], { cwd: f.cwd })).stdout, "PRIMARY=50\n");
});

test("source permission changes after measurement invalidate acceptance", async (t) => {
  const f = await harness(t);
  await f.run();
  fs.chmodSync(path.join(f.cwd, "source.sh"), 0o755);
  assert.equal((await f.log(100)).isError, true);
});
