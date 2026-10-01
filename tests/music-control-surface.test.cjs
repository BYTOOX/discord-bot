const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { MusicControlSurfaceService } = require('../src/modules/music/MusicControlSurfaceService.ts');
const { MessageFlags } = require('discord.js');
const logger = {warn(){},error(){},info(){}};
const service = () => new MusicControlSurfaceService({}, logger);

test('upgrading an existing panel clears legacy fields in the Discord edit payload', async () => {
  let sent;
  const message = {id:'1',channelId:'2',edit:async payload=>{sent=payload;}};
  await service().editManagedMessage(message,{flags:MessageFlags.IsComponentsV2,components:[{type:10,content:'Playing'}]},{});
  assert.equal(sent.content, null);
  assert.deepEqual(sent.embeds, []);
  assert.equal(sent.flags,32768);
  assert.equal(sent.components[0].content,'Playing');
});

test('command center embed edits keep their embeds', async () => {
  let sent;
  await service().editManagedMessage({edit:async p=>{sent=p;}},{embeds:[{title:'Command center'}]},{});
  assert.deepEqual(sent.embeds,[{title:'Command center'}]);
  assert.equal(sent.flags,undefined);
});

test('session fallback remains compatible with an existing components V2 panel', () => {
  const payload = service().buildLegacySessionPayload({slotId:'jukebox-1',callsign:'Test Jukebox',mode:'queued',voiceChannelId:'123',trackTitle:'Example track',trackAuthor:'Artist',sourceLabel:'YouTube',positionMs:1000,durationMs:10000,volume:50,queueDepth:1,queuePreview:['Next track']},'Loading');
  assert.equal(payload.flags,32768);
  assert.equal(payload.embeds,undefined);
  const serialized=JSON.stringify(payload.components);
  assert.ok(serialized.includes('Example track'));
  assert.ok(serialized.includes('Next track'));
});

test('closing a recovered session remains compatible with components V2', () => {
  const payload=service().buildSessionClosedPayload('Playback stopped');
  assert.equal(payload.flags,32768);
  assert.equal(payload.embeds,undefined);
  assert.ok(JSON.stringify(payload.components).includes('Playback stopped'));
});

test('a fallback session panel can be recovered when its registry entry is missing', () => {
  const svc=new MusicControlSurfaceService({user:{id:'123'}},logger);
  const message={author:{id:'123'},embeds:[],components:[{type:17,components:[{type:10,content:'### Test Jukebox\n\nExample track'}]}]};
  assert.equal(svc.isSessionPanelMessage(message,{callsign:'Test Jukebox'}),true);
  assert.equal(svc.isSessionPanelMessage({...message,author:{id:'456'}},{callsign:'Test Jukebox'}),false);
});

test('a rejected panel update on playback events does not crash the bot process', () => {
  const child = spawnSync(process.execPath, ['--import','tsx','--unhandled-rejections=strict','-e', `
    const {EventEmitter}=require('node:events');
    const {ChannelBoundJukeboxCoordinator}=require('./src/modules/orchestrator/ChannelBoundJukeboxCoordinator.ts');
    const orchestrator=new EventEmitter();
    orchestrator.refreshRegisteredMusicPanel=async()=>{throw Error('Discord panel rejected');};
    const jukebox=new EventEmitter();
    jukebox.lavalinkService={manager:new EventEmitter()};
    let warnings=0;
    new ChannelBoundJukeboxCoordinator(orchestrator,[jukebox],['Test'],{warn(){warnings++;},info(){}}).initialize();
    jukebox.lavalinkService.manager.emit('trackStart',{guildId:'123'});
    jukebox.lavalinkService.manager.emit('queueEnd',{guildId:'123'});
    setImmediate(()=>{if(warnings!==2)process.exitCode=2;});
  `], {cwd:require('node:path').resolve(__dirname,'..'),encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
});
