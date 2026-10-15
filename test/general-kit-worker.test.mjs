import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { materialIdentity, openMaterialStore } from '../worker/material-store.mjs';

test('a real run adapter hands its image to Worker custody and reports a registered artifact', t => {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const scratch = path.join(repo, '.scratch'); fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'general-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project'), home = path.join(dir, 'pins'), materials = path.join(dir, 'materials');
  fs.mkdirSync(root); fs.mkdirSync(path.join(home, 'specs'), { recursive: true });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(root, 'tiny.png'), image);
  const identity = materialIdentity({ configFile: path.join(dir, 'fixture-config.json'), connectionId: 'fixture' });
  openMaterialStore(materials, identity);
  const probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(probe, `
    import assert from 'node:assert/strict';
    import { execute, prepareActionReport } from ${JSON.stringify(pathToFileURL(path.join(repo, 'worker/rulith-worker.mjs')).href)};
    const execution = await execute('image', {path:'tiny.png'}, {image:{
      impl:'run', cmd:process.execPath, args:[${JSON.stringify(path.join(repo, 'kits/general/read_image.mjs'))}],
      passArgs:true, artifactOutput:true, returns:[], envPass:['ENG_KIT_HOME'], source:'lab',
    }}, {lab:{type:'file',access:${JSON.stringify(root)}}}, {resultBytes:1000});
    assert.equal(execution.localArtifact.mediaType, 'image/png');
    assert.equal(execution.localArtifact.totalBytes, ${image.length});
    const prepared = await prepareActionReport({work:'image',artifactPolicy:{inlineBytes:8192,objectBytes:1000}}, {ok:true,...execution}, {
      register: async record => ({ref:'art_'+'b'.repeat(32),mediaType:record.mediaType,
        digest:record.digest,encoding:record.encoding,totalBytes:record.totalBytes}),
    });
    process.stdout.write(JSON.stringify(prepared));
  `);
  const output = execFileSync(process.execPath, [probe], { encoding: 'utf8', windowsHide: true, env: {
    ...process.env, ENG_KIT_HOME: home, RULITH_MATERIALS_ROOT: materials,
    RULITH_MATERIALS_PROFILE: identity.profile, RULITH_MATERIALS_OWNER: identity.owner,
    RULITH_MATERIALS_AGENT_FINGERPRINT: '', RULITH_MATERIALS_DEVICE_ID: '',
    RULITH_MATERIALS_MODEL_DESTINATION: identity.modelDestination,
    RULITH_WORKER_EVENTS: '', RULITH_LOCAL_EVENTS: '',
  } });
  const prepared = JSON.parse(output);
  assert.equal(prepared.unavailable, undefined);
  assert.deepEqual(prepared.body.artifacts, [{ ref: 'art_' + 'b'.repeat(32) }]);
  assert.equal(prepared.body.facts, undefined);
  assert.doesNotMatch(output, /iVBOR|tiny.png/);
});

test('an existing run adapter relays artifacts JSON byte-for-byte through the real Worker', t => {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const scratch = path.join(repo, '.scratch'); fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'general-worker-relay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stdout = ' {"artifacts":[{"id":123,"name":"build"}]}\n';
  const adapter = path.join(dir, 'relay.mjs'), probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(adapter, `process.stdout.write(${JSON.stringify(stdout)});`);
  fs.writeFileSync(probe, `
    import { execute } from ${JSON.stringify(pathToFileURL(path.join(repo, 'worker/rulith-worker.mjs')).href)};
    const out = await execute('relay', {}, { relay: { impl:'run', cmd:process.execPath,
      args:[${JSON.stringify(adapter)}], returns:[], source:'lab' } }, {lab:{type:'file',access:${JSON.stringify(dir)}}});
    process.stdout.write(out);
  `);
  const out = execFileSync(process.execPath, [probe], { encoding: 'utf8', windowsHide: true, env: {
    ...process.env, RULITH_WORKER_EVENTS: '', RULITH_LOCAL_EVENTS: '',
  } });
  assert.equal(out, stdout);
});

test('concurrent processes recover a dead Source lock without overlapping actions', t => {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const scratch = path.join(repo, '.scratch'); fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, 'general-worker-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'tree.json'), critical = path.join(dir, 'critical'), events = path.join(dir, 'events');
  fs.writeFileSync(`${stateFile}.lock`, JSON.stringify({ pid: 2147483647, startedAt: '2020-01-01T00:00:00Z' }));
  const child = path.join(dir, 'contender.mjs'), probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(child, `
    import fs from 'node:fs';
    import { locked, sleep } from ${JSON.stringify(pathToFileURL(path.join(repo, 'kits/general/lib.mjs')).href)};
    let done = 0;
    for (let tries = 0; done < 3 && tries < 500; tries++) {
      try {
        await locked({stateFile:${JSON.stringify(stateFile)}}, async () => {
          // Exclusive marker detects actual overlap, independently of lock implementation.
          const fd = fs.openSync(${JSON.stringify(critical)}, 'wx');
          try { await sleep(5); fs.appendFileSync(${JSON.stringify(events)}, 'done\\n'); }
          finally { fs.closeSync(fd); fs.unlinkSync(${JSON.stringify(critical)}); }
        });
        done++;
      } catch (error) { if (error.message !== 'adapter busy') throw error; }
      await sleep(5);
    }
    if (done !== 3) throw new Error('lock did not make progress');
  `);
  fs.writeFileSync(probe, `
    import { spawn } from 'node:child_process';
    await Promise.all(Array.from({length:6}, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [${JSON.stringify(child)}], {windowsHide:true,stdio:['ignore','ignore','pipe']});
      let stderr = ''; child.stderr.on('data', chunk => {stderr += chunk;});
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
    })));
  `);
  execFileSync(process.execPath, [probe], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(fs.readFileSync(events, 'utf8').trim().split('\n').length, 18);
  assert.equal(fs.existsSync(`${stateFile}.lock`), false);
});
