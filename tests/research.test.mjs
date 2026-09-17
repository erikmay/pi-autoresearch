import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ResearchSession } from '../extensions/pi-autoresearch/research.ts';

const accept = async () => JSON.stringify({ accept: true, reason: 'General improvement supported by independent evidence.', overfittingRisks: [], requiredValidation: [] });
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
  write('.auto/holdout.sh', '. ./source.sh\nprintf "METRIC validation=%s\\n" "$HOLDOUT"\n');
  write('.auto/research.json', JSON.stringify({ objective: 'Reduce execution time while preserving generalization.', constraints: ['Preserve correctness.'], sourceFiles: ['source.sh'], validationMetrics: [{ name: 'validation', direction: 'lower', maxRegressionPercent: 0 }], repetitions: 3 }));
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
/** Establish the baseline (no model call), then measure a changed candidate at PRIMARY=90. */
async function candidate(f, session = f.session) {
  await measure(f, session);
  let calls = 0;
  await session.review(100, async () => { calls++; return accept(); });
  assert.equal(calls, 0, 'The unchanged baseline must not invoke the evaluator.');
  session.consume(true);
  f.write('source.sh', 'PRIMARY=90\nHOLDOUT=100\n');
  return measure(f, session);
}

test('fresh measured metric is required and cannot be replaced by a claimed value', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.session.review(1, accept), /without fresh/);
  await measure(f);
  await assert.rejects(f.session.review(1, accept), /differs from measured/);
  assert.equal((await f.session.review(100, accept)).review.accept, true);
  f.session.consume(true);
  await assert.rejects(f.session.review(100, accept), /without fresh/);
  assert.throws(() => f.session.consume(true), /Missing independent acceptance/);
});

test('source changes invalidate measurement and changes made during review', async (t) => {
  const f = fixture(t);
  await measure(f);
  f.write('source.sh', 'PRIMARY=90\nHOLDOUT=100\n');
  await assert.rejects(f.session.review(100, accept), /Source changed after measurement/);
  await measure(f);
  await assert.rejects(f.session.review(90, async () => {
    f.write('source.sh', 'PRIMARY=80\nHOLDOUT=100\n');
    return accept();
  }), /source changed during evaluation/);
});

test('evaluation scripts and saved reference are protected contracts', async (t) => {
  for (const file of ['.auto/measure.sh', '.auto/holdout.sh', '.auto/research.json', '.auto/research-state.json']) {
    await t.test(file, async (t) => {
      const f = fixture(t);
      await measure(f);
      fs.appendFileSync(path.join(f.cwd, file), '\n ');
      await assert.rejects(f.session.review(100, accept), /changed/);
    });
  }
});

test('persisted holdout reference rejects later regression without invoking the reviewer', async (t) => {
  const f = fixture(t);
  await measure(f);
  f.session.consume(false);
  await measure(f);
  await f.session.review(100, accept);
  f.session.consume(true);
  const restarted = new ResearchSession(f.cwd, exec);
  f.write('source.sh', 'PRIMARY=50\nHOLDOUT=110\n');
  await measure(f, restarted);
  let calls = 0;
  const result = await restarted.review(50, async () => { calls++; return accept(); });
  assert.equal(result.review.accept, false);
  assert.match(result.review.reason, /Holdout regression/);
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.cwd, '.auto/research-state.json'), 'utf8')).reference, { validation: 100 });
});

test('regression tolerance cannot accumulate drift beyond the original baseline', async (t) => {
  const f = fixture(t);
  const configFile = path.join(f.cwd, '.auto/research.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.validationMetrics[0].maxRegressionPercent = 10;
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.unlinkSync(path.join(f.cwd, '.auto/research-state.json'));
  const session = new ResearchSession(f.cwd, exec);
  await measure(f, session); await session.review(100, accept); session.consume(true);
  f.write('source.sh', 'PRIMARY=90\nHOLDOUT=105\n');
  await measure(f, session); await session.review(90, accept); session.consume(true);
  f.write('source.sh', 'PRIMARY=80\nHOLDOUT=110.25\n');
  await measure(f, session);
  let called = false;
  const result = await session.review(80, async () => { called = true; return accept(); });
  assert.equal(result.review.accept, false);
  assert.equal(called, false);
});

test('invalid or unavailable evaluator and outstanding validation fail closed', async (t) => {
  const responses = [async () => 'not json', async () => { throw new Error('Provider unavailable'); }, async () => JSON.stringify({ accept: true, reason: 'Needs another check.', overfittingRisks: [], requiredValidation: ['Check unseen workloads.'] }), async () => JSON.stringify({ accept: 'yes', reason: 'Invalid decision.', overfittingRisks: [], requiredValidation: [] })];
  for (const [index, response] of responses.entries()) {
    await t.test(String(index), async (t) => {
      const f = fixture(t);
      await candidate(f);
      const result = await f.session.review(90, response);
      assert.equal(result.review.accept, false);
      assert.throws(() => f.session.consume(true), /Missing independent acceptance/);
    });
  }
});

test('failed benchmark and missing primary evidence never invoke the evaluator', async (t) => {
  const f = fixture(t);
  for (const [primary, passed] of [[null, true], [100, false], [NaN, true]]) {
    const snapshot = await f.session.begin();
    await f.session.measure(snapshot, 'time', primary, passed, 'Failed benchmark');
    let called = false;
    const result = await f.session.review(primary, async () => { called = true; return accept(); }).catch(error => error);
    if (Number.isNaN(primary)) assert.match(result.message, /differs from measured/);
    else assert.equal(result.review.accept, false);
    assert.equal(called, false);
    f.session.consume(false);
  }
});

test('the outside advisor sees approach names only, skips known approaches, and can stop the loop', async (t) => {
  const f = fixture(t);
  const marker = 'HISTORY_CONTAMINATION_SENTINEL';
  f.write('.auto/ideas.md', marker);
  f.write('.auto/log.jsonl', JSON.stringify({ description: marker, asi: { next_action_hint: marker } }));
  f.write('.auto/prompt.md', marker);
  assert.throws(() => f.session.assertApproachOpen('Not Valid'), /kebab-case/);
  for (const kept of [true, false, false]) assert.equal(f.session.recordApproach('value-cache', kept), false);
  assert.equal(f.session.recordApproach('value-cache', false), true);
  assert.throws(() => f.session.assertApproachOpen('value-cache'), /closed/);
  assert.equal(f.session.recordApproach('field-order', false), false);
  const payloads = [];
  const result = await f.session.ideate(async (model, system, data) => {
    payloads.push({ model, system, data });
    return JSON.stringify({ verdict: 'continue', reason: 'Untried directions remain.', ideas: [
      { approach: 'Value Cache', hypothesis: 'Repeat.', change: 'Cache immutable computation.', mechanism: 'Compute once.', validation: 'Compare unseen workloads.' },
      { approach: 'Batch Normalization', hypothesis: 'Fewer calls win.', change: 'Normalize all fields once.', mechanism: 'One conversion.', validation: 'Compare misses.' },
    ] });
  });
  assert.equal(payloads.length, 1);
  assert.equal(JSON.stringify(payloads[0]).includes(marker), false);
  assert.deepEqual(Object.keys(payloads[0].data).sort(), ['approaches', 'constraints', 'objective', 'source']);
  assert.deepEqual(payloads[0].data.approaches, { open: ['field-order (1 attempts, 0 kept)'], closed: ['value-cache (4 attempts, 1 kept)'] });
  assert.equal(result.stop, false);
  assert.match(result.text, /1 new approaches/);
  const journal = JSON.parse(fs.readFileSync(path.join(f.cwd, '.auto/ideation.jsonl'), 'utf8').trim());
  assert.deepEqual(journal.ideas.map((i) => i.approach), ['batch-normalization']);
  assert.match(fs.readFileSync(path.join(f.cwd, '.auto/ideas.md'), 'utf8'), /- \[ \] Approach: batch-normalization \|/);
  const stop = await f.session.ideate(async () => JSON.stringify({ verdict: 'stop', reason: 'The remaining work is noise.', ideas: [] }));
  assert.equal(stop.stop, true);
  assert.match(stop.text, /recommends stopping: The remaining work is noise/);
  await assert.rejects(f.session.ideate(async () => { throw new Error('Unavailable'); }), /Unavailable/);
});

test('cancelled sessions cannot continue research', async (t) => {
  const f = fixture(t);
  await measure(f);
  f.session.cancel();
  await assert.rejects(f.session.review(100, accept), /without fresh/);
  await assert.rejects(f.session.begin(), /stopped/);
});

test('holdout failure and code mutation during validation block acceptance', async (t) => {
  for (const [name, script, expected] of [
    ['nonzero exit', 'exit 1\n', /validation failed/],
    ['duplicate metric', 'printf "METRIC validation=100\\nMETRIC validation=100\\n"\n', /duplicate holdout metric/],
    ['source mutation', 'printf "PRIMARY=90\\nHOLDOUT=100\\n" > source.sh\nprintf "METRIC validation=100\\n"\n', /Source changed during holdout/],
  ]) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      f.write('.auto/holdout.sh', script);
      fs.unlinkSync(path.join(f.cwd, '.auto/research-state.json'));
      const session = new ResearchSession(f.cwd, exec);
      const evidence = await measure(f, session);
      assert.equal(evidence.validationPassed, false);
      assert.match(evidence.failure, expected);
      if (name === 'source mutation') {
        await assert.rejects(session.review(100, accept), /Source changed after measurement/);
      } else {
        let calls = 0;
        const result = await session.review(100, async () => { calls++; return accept(); });
        assert.equal(result.review.accept, false);
        assert.equal(calls, 0);
      }
    });
  }
});

function resetConfig(f, updates) {
  const file = path.join(f.cwd, '.auto/research.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  f.write('.auto/research.json', JSON.stringify({ ...config, ...updates }));
  fs.unlinkSync(path.join(f.cwd, '.auto/research-state.json'));
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
    const result = await session.review(90, async () => new Promise(() => {}));
    assert.equal(result.review.accept, false);
    assert.match(result.review.reason, /cancelled or timed out/);
    assert.ok(Date.now() - started < 5000, 'Provider must not block beyond the configured deadline.');
    assert.throws(() => session.consume(true), /Missing independent acceptance/);
  } finally {
    clearInterval(keepAlive);
  }
});

test('stopping a session during a model request prevents approval', async (t) => {
  const f = fixture(t);
  await candidate(f);
  let entered;
  const requestStarted = new Promise(resolve => { entered = resolve; });
  let modelSignal;
  const pending = f.session.review(90, async (_model, _system, _data, signal) => {
    modelSignal = signal;
    entered();
    return new Promise(() => {});
  });
  await requestStarted;
  f.session.cancel();
  await assert.rejects(pending, /Research session was stopped/);
  assert.equal(modelSignal.aborted, true);
  assert.throws(() => f.session.consume(true), /Research session was stopped/);
  // Only the baseline review is journaled; the cancelled candidate never reaches the journal or the reference.
  assert.equal(fs.readFileSync(path.join(f.cwd, '.auto/reviews.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.cwd, '.auto/research-state.json'), 'utf8')).reference, { validation: 100 });
});

test('evaluation helpers are frozen and full evaluation source reaches only the reviewer', async (t) => {
  const f = fixture(t);
  const marker = 'HOLDOUT_SOURCE_SENTINEL';
  f.write('.auto/helper.sh', `# ${marker}\nprintf "helper"\n`);
  const session = resetConfig(f, { evaluationFiles: ['.auto/helper.sh'] });
  await candidate(f, session);
  let reviewedData;
  const result = await session.review(90, async (_model, _system, data) => {
    reviewedData = data;
    return accept();
  });
  assert.equal(result.review.accept, true);
  for (const file of ['.auto/helper.sh', '.auto/holdout.sh', '.auto/measure.sh']) {
    assert.equal(reviewedData.evaluationSource[file], fs.readFileSync(path.join(f.cwd, file), 'utf8'));
  }
  await session.ideate(async (_model, _system, data) => {
    assert.equal(Object.hasOwn(data, 'evaluationSource'), false);
    assert.equal(JSON.stringify(data).includes(marker), false);
    return JSON.stringify({ verdict: 'continue', reason: 'Open directions remain.', ideas: [{ approach: 'hash-set', hypothesis: 'Reduce comparisons.', change: 'Use a hash set.', mechanism: 'Track prior values.', validation: 'Check diverse arrays.' }] });
  });
  f.write('.auto/helper.sh', '# changed protected evaluation helper\n');
  await assert.rejects(session.review(90, accept), /Protected research config or evaluation script changed/);
  assert.throws(() => new ResearchSession(f.cwd, exec), /Research contract changed/);
});

test('oversized evaluator output is rejected before parsing or acceptance', async (t) => {
  const f = fixture(t);
  await candidate(f);
  const response = JSON.stringify({ accept: true, reason: 'Accepted.', overfittingRisks: [], requiredValidation: [], padding: 'x'.repeat(33 * 1024) });
  const result = await f.session.review(90, async () => response);
  assert.equal(result.review.accept, false);
  assert.match(result.review.reason, /Model response exceeds 32 KiB/);
  assert.throws(() => f.session.consume(true), /Missing independent acceptance/);
});
