import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { publicEncrypt, constants } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createLocalHost, defaultLocalConfig, rolesFromArgs } from '../local/rulith-local.mjs'
import { setupOrigin } from '../local/setup-service.mjs'

for (const mode of ['existing_agent', 'local_agent']) test('setup pairs '+mode+' without exposing credentials and resumes a lost acknowledgement',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'rulith-setup-')),configFile=join(dir,'local.json'),config=defaultLocalConfig();
  config.unrelated={preserve:true};writeFileSync(configFile,JSON.stringify(config));
  const requests=[];let pairing,acked=false,failAck=true;
  const cloud=createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):{};requests.push({path:req.url,body});res.setHeader('content-type','application/json');
    if(req.url==='/local-setup/start'){pairing=body;res.end(JSON.stringify({code:'ABCD2345',expiresAt:new Date(Date.now()+600000).toISOString()}));}
    else if(req.url==='/local-setup/poll'){assert.equal(body.pairingId,pairing.requestId);res.end(JSON.stringify({pairingId:pairing.requestId,clientMode:mode,agentId:'agent-setup',connectionId:'owner-worker',key:'private-worker-key',...(mode==='local_agent'?{encryptedAgentToken:publicEncrypt({key:pairing.publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from('rlt_agt_private-agent-key')).toString('base64')}:{})}));}
    else if(req.url==='/local-setup/ack'){if(failAck){failAck=false;res.writeHead(503);res.end(JSON.stringify({teaching:'Retry acknowledgement'}));}else{acked=true;res.end('{}');}}
    else if(req.url==='/local-setup/context'){assert.equal(req.headers['x-rulith-connection-key'],'private-worker-key');res.end(JSON.stringify({agentId:'agent-setup',agentName:'Setup',sources:[]}));}
    else if(req.url==='/local-setup/resources'){res.end(JSON.stringify({revision:'test',state:'awaiting_authorization'}));}
    else{res.writeHead(404);res.end('{}');}
  });await new Promise(r=>cloud.listen(0,'127.0.0.1',r));
  let host=createLocalHost({configFile,config,roles:config.roles,port:0,autoStart:false});await host.listen();
  t.after(async()=>{await host.close();await new Promise(r=>cloud.close(r));rmSync(dir,{recursive:true,force:true});});
  const call=async(path,body,headers={})=>{const response=await fetch('http://127.0.0.1:'+host.port+path,{method:body===undefined?'GET':'POST',headers:{'x-rulith-local':host.key,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};};
  assert.deepEqual(rolesFromArgs(['setup'],['worker']),['worker']);assert.equal(host.status().agent,false);
  assert.equal((await call('/setup/pair/start',{}, {origin:'http://localhost:1'})).status,403);
  const base='http://127.0.0.1:'+cloud.address().port;
  assert.equal((await call('/setup/pair/start',{consoleUrl:base,name:'Laptop / 中文',clientMode:mode})).status,200);
  assert.equal((await call('/setup/pair/poll',{})).status,400,'failed acknowledgement is not marked complete');
  const saved=JSON.parse(readFileSync(configFile));assert.equal(saved.worker.env.RULITH_CONNECTION_KEY,'private-worker-key');assert.deepEqual(saved.unrelated,{preserve:true});
  assert.deepEqual(saved.roles,mode==='local_agent'?['agent','worker']:['worker']);
  assert.equal(saved.agent.env.RULITH_TOKEN,mode==='local_agent'?'rlt_agt_private-agent-key':'');
  await host.close();host=createLocalHost({configFile,config:saved,roles:saved.roles,port:0,autoStart:false});await host.listen();
  assert.equal((await call('/setup/pair/poll',{})).status,200);assert.equal(acked,true);
  assert.equal(requests.filter(r=>r.path==='/local-setup/poll').length,1,'resume acknowledges already persisted credential without fetching a replacement');
  assert.equal(readFileSync(configFile+'.setup.json','utf8').includes('PRIVATE KEY'),false);
  const state=JSON.stringify((await call('/setup/state')).body);for(const secret of ['private-worker-key','private-agent-key','deviceSecret','PRIVATE KEY'])assert.equal(state.includes(secret),false);
  assert.equal((await call('/setup/pair/start',{consoleUrl:base,name:'different',clientMode:mode})).status,400,'linked identity cannot be retargeted');
  assert.equal((await call('/setup/model',{url:'http://localhost:8080/v1',name:'local-model',key:'private-model-key'})).status,200);
  assert.equal(JSON.stringify(requests).includes('private-model-key'),false,'model credentials never reach Cloud');
  assert.equal(JSON.stringify((await call('/setup/state')).body).includes('private-model-key'),false);
  assert.equal((await call('/setup/resources',{resources:[],services:[]})).body.state,'awaiting_authorization');
  assert.equal(requests.some(r=>r.path.startsWith('/api/sources/')),false,'Local proposals never authorize resources');
});
test('setup rejects arbitrary HTTP origins and URI credentials',()=>{
  for(const url of ['http://remote.example','https://user:secret@example.com','https://example.com/?token=a','https://example.com/console'])assert.throws(()=>setupOrigin(url));
  assert.equal(setupOrigin('https://console.rulith.ai/'),'https://console.rulith.ai');
});
