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
  write('.auto/research.json', JSON.stringify({ objective: 'Reduce execution time while preserving generalization.', constraints: ['Preserve correctness.'], sourceFiles: ['source.sh'], reviewModel: 'fake/reviewer', ideaModels: ['fake/algorithm', 'fake/alternative', 'fake/profiling'], validationMetrics: [{ name: 'validation', direction: 'lower', maxRegressionPercent: 0 }], repetitions: 3 }));
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

test('invalid or unavailable evaluator and outstanding validation fail closed', async (t) => {
  const responses = [async () => 'not json', async () => { throw new Error('Provider unavailable'); }, async () => JSON.stringify({ accept: true, reason: 'Needs another check.', overfittingRisks: [], requiredValidation: ['Check unseen workloads.'] }), async () => JSON.stringify({ accept: 'yes', reason: 'Invalid decision.', overfittingRisks: [], requiredValidation: [] })];
  for (const [index, response] of responses.entries()) {
    await t.test(String(index), async (t) => {
      const f = fixture(t);
      await measure(f);
      const result = await f.session.review(100, response);
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

test('fresh ideation excludes history and retains successful agents when another fails', async (t) => {
  const f = fixture(t);
  const marker = 'HISTORY_CONTAMINATION_SENTINEL';
  f.write('.auto/ideas.md', marker);
  f.write('.auto/log.jsonl', JSON.stringify({ description: marker, asi: { next_action_hint: marker } }));
  f.write('.auto/prompt.md', marker);
  const payloads = [];
  const result = await f.session.ideate(async (model, system, data) => {
    payloads.push({ model, system, data });
    if (model === 'fake/alternative') throw new Error('Agent unavailable');
    return JSON.stringify({ ideas: [{ hypothesis: 'Avoid redundant work.', change: 'Cache immutable computation.', mechanism: 'Compute once.', validation: 'Compare unseen workloads.' }] });
  });
  assert.equal(payloads.length, 3);
  for (const payload of payloads) {
    assert.equal(JSON.stringify(payload).includes(marker), false);
    assert.deepEqual(Object.keys(payload.data).sort(), ['constraints', 'objective', 'source']);
  }
  assert.match(result, /1 candidates \(1 agents failed\)/);
  const journal = JSON.parse(fs.readFileSync(path.join(f.cwd, '.auto/ideation.jsonl'), 'utf8').trim());
  assert.equal(journal.errors.length, 1);
  assert.equal(journal.ideas.length, 2);
  assert.equal((fs.readFileSync(path.join(f.cwd, '.auto/ideas.md'), 'utf8').match(/- \[ \]/g) || []).length, 1);
  await assert.rejects(f.session.ideate(async () => { throw new Error('Unavailable'); }), /All idea agents failed/);
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
