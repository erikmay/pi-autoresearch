import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ResearchSession } from '../extensions/pi-autoresearch/research.ts';

const advice = async () => JSON.stringify({ verdict: 'continue', reason: 'Try another algorithm.', ideas: [{ approach: 'hash-set', hypothesis: 'Reduce comparisons.', change: 'Use a hash set.', mechanism: 'Track prior values.', validation: 'Check diverse arrays.' }] });
const primary = { name: 'time', direction: 'lower' };
const exec = async (command, args, options) => {
  const r = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8', timeout: options.timeout, signal: options.signal });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, killed: Boolean(r.signal) };
};
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-research-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const write = (name, content) => fs.writeFileSync(path.join(cwd, name), content);
  fs.mkdirSync(path.join(cwd, '.auto'));
  write('.gitignore', '.auto/\n');
  write('source.sh', 'PRIMARY=100\nHOLDOUT=100\n');
  write('.auto/measure.sh', '. ./source.sh\nprintf "METRIC time=%s\\n" "$PRIMARY"\n');
  write('.auto/research.json', JSON.stringify({ objective: 'Reduce execution time while preserving generalization.', constraints: ['Preserve correctness.'], sourceFiles: ['source.sh'], failureInterval: 3 }));
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Research Test'], ['add', '.'], ['commit', '-qm', 'Baseline']]) {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  return { cwd, write, session: new ResearchSession(cwd, exec) };
}
async function measure(f, session = f.session) {
  const snapshot = await session.begin();
  const r = await exec('bash', ['.auto/measure.sh'], { cwd: f.cwd, timeout: 10000 });
  const metric = Number(r.stdout.match(/^METRIC time=(\S+)/m)?.[1]);
  return session.measure(snapshot, 'time', metric, r.code === 0, r.stdout);
}
/** Establish the baseline, then measure a changed candidate at PRIMARY=90. */
async function candidate(f, session = f.session) {
  await measure(f, session);
  await session.assertCanKeep(100, 'time');
  session.consume();
  f.write('source.sh', 'PRIMARY=90\nHOLDOUT=100\n');
  return measure(f, session);
}

test('fresh measured metric is required and cannot be replaced by a claimed value', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.session.assertCanKeep(1, 'time'), /without fresh/);
  await measure(f);
  await assert.rejects(f.session.assertCanKeep(1, 'time'), /differs from measured/);
  await f.session.assertCanKeep(100, 'time');
  f.session.consume();
  await assert.rejects(f.session.assertCanKeep(100, 'time'), /without fresh/);
});

test('source changes invalidate measurement', async (t) => {
  const f = fixture(t);
  await measure(f);
  f.write('source.sh', 'PRIMARY=90\nHOLDOUT=100\n');
  await assert.rejects(f.session.assertCanKeep(100, 'time'), /Source changed after measurement/);
});

test('evaluation scripts are protected during the session', async (t) => {
  for (const file of ['.auto/measure.sh', '.auto/research.json']) {
    await t.test(file, async (t) => {
      const f = fixture(t);
      await measure(f);
      fs.appendFileSync(path.join(f.cwd, file), '\n ');
      await assert.rejects(f.session.assertCanKeep(100, 'time'), /changed/);
    });
  }
});

test('failed benchmark and missing primary evidence block acceptance without hiding the failure', async (t) => {
  const f = fixture(t);
  for (const [metric, passed] of [[null, true], [100, false], [NaN, true]]) {
    const snapshot = await f.session.begin();
    const result = await f.session.measure(snapshot, 'time', metric, passed, 'Error: baseline recognition lost');
    assert.equal(result.passed, false);
    if (!passed) assert.match(result.failure, /Benchmark failed[\s\S]*baseline recognition lost/);
    await assert.rejects(f.session.assertCanKeep(metric, 'time'));
    f.session.consume();
  }
});

test('the outside advisor sees measured outcomes, allows useful variants, and can stop the loop', async (t) => {
  const f = fixture(t);
  const marker = 'HISTORY_CONTAMINATION_SENTINEL';
  f.write('.auto/ideas.md', marker);
  f.write('.auto/log.jsonl', JSON.stringify({ description: marker, asi: { next_action_hint: marker } }));
  f.write('.auto/prompt.md', marker);
  assert.throws(() => f.session.approachName('Not Valid'), /kebab-case/);
  const results = [
    { approach: 'value-cache', status: 'keep', metric: 100, checksPassed: true },
    { approach: 'value-cache', status: 'discard', metric: 110, checksPassed: true },
    { approach: 'value-cache', status: 'checks_failed', metric: 90, checksPassed: false },
    { approach: 'constructor', status: 'discard', metric: 120, checksPassed: true },
  ];
  const payloads = [];
  const result = await f.session.ideate(async (model, system, data) => {
    payloads.push({ model, system, data });
    return JSON.stringify({ verdict: 'continue', reason: 'A useful variant remains.', ideas: [
      { approach: 'Value Cache', hypothesis: 'Reduce misses.', change: 'Cache immutable computation.', mechanism: 'Compute once.', validation: 'Compare unseen workloads.' },
    ] });
  }, results, primary);
  assert.equal(payloads.length, 1);
  assert.equal(JSON.stringify(payloads[0]).includes(marker), false);
  assert.deepEqual(payloads[0].data.primary, { ...primary, baseline: 100, best: 100 });
  assert.deepEqual(payloads[0].data.approaches[0], { name: 'value-cache', attempts: 3, kept: 1, bestKeptMetric: 100, lastResult: results[2] });
  assert.equal(result.stop, false);
  assert.match(result.text, /1 suggestions/);
  const journal = JSON.parse(fs.readFileSync(path.join(f.cwd, '.auto/ideation.jsonl'), 'utf8').trim());
  assert.deepEqual(journal.ideas.map((i) => i.approach), ['value-cache']);
  assert.match(fs.readFileSync(path.join(f.cwd, '.auto/ideas.md'), 'utf8'), /- \[ \] Approach: value-cache \|/);
  const stop = await f.session.ideate(async () => JSON.stringify({ verdict: 'stop', reason: 'The remaining work is noise.', ideas: [] }), results, primary);
  assert.equal(stop.stop, true);
  assert.match(stop.text, /recommends stopping: The remaining work is noise/);
  await assert.rejects(f.session.ideate(async () => { throw new Error('Unavailable'); }, results, primary), /Unavailable/);
});

test('cancelled sessions cannot continue research', async (t) => {
  const f = fixture(t);
  await measure(f);
  f.session.cancel();
  await assert.rejects(f.session.assertCanKeep(100, 'time'), /without fresh/);
  await assert.rejects(f.session.begin(), /stopped/);
});

function resetConfig(f, updates) {
  const file = path.join(f.cwd, '.auto/research.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  f.write('.auto/research.json', JSON.stringify({ ...config, ...updates }));
  return new ResearchSession(f.cwd, exec);
}

test('model requests time out even when the provider ignores cancellation', async (t) => {
  const f = fixture(t);
  const session = resetConfig(f, { timeoutSeconds: 1 });
  await candidate(f, session);
  const started = Date.now();
  // Keep Node alive because AbortSignal.timeout uses an unreferenced timer.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(session.ideate(async () => new Promise(() => {}), [], primary), /cancelled or timed out/);
    assert.ok(Date.now() - started < 5000, 'Provider must not block beyond the configured deadline.');
  } finally {
    clearInterval(keepAlive);
  }
});

test('stopping a session during an advisor request cancels the request', async (t) => {
  const f = fixture(t);
  let entered;
  const requestStarted = new Promise(resolve => { entered = resolve; });
  let modelSignal;
  const pending = f.session.ideate(async (_model, _system, _data, signal) => {
    modelSignal = signal;
    entered();
    return new Promise(() => {});
  }, [], primary);
  await requestStarted;
  f.session.cancel();
  await assert.rejects(pending, /cancelled or timed out/);
  assert.equal(modelSignal.aborted, true);
  assert.equal(fs.existsSync(path.join(f.cwd, '.auto/ideation.jsonl')), false);
});

test('evaluation helpers are frozen and are not sent to the advisor', async (t) => {
  const f = fixture(t);
  const marker = 'CHECKS_SOURCE_SENTINEL';
  f.write('.auto/helper.sh', `# ${marker}\nprintf "helper"\n`);
  const session = resetConfig(f, { evaluationFiles: ['.auto/helper.sh'] });
  await candidate(f, session);
  await session.ideate(async (_model, _system, data) => {
    assert.equal(Object.hasOwn(data, 'evaluationSource'), false);
    assert.equal(JSON.stringify(data).includes(marker), false);
    return advice();
  }, [], primary);
  f.write('.auto/helper.sh', '# changed protected evaluation helper\n');
  await assert.rejects(session.assertCanKeep(90, 'time'), /Protected research config or evaluation script changed/);
});

test('oversized advisor output is rejected before use', async (t) => {
  const f = fixture(t);
  const response = JSON.stringify({ verdict: 'stop', reason: 'Done.', ideas: [], padding: 'x'.repeat(33 * 1024) });
  await assert.rejects(f.session.ideate(async () => response, [], primary), /Model response exceeds 32 KiB/);
});
