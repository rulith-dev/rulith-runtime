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
      passArgs:true, returns:[], envPass:['ENG_KIT_HOME'], source:'lab',
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
