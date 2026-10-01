const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MusicService } = require('../src/modules/music/MusicService.ts');

const logger = {warn(){},error(){},info(){}};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function setup({stayInVoice = false} = {}) {
  const members = new Map();
  const channel = {
    isVoiceBased: () => true,
    get members() {
      return {filter: fn => ({size: [...members.values()].filter(fn).length})};
    }
  };
  const guild = {id: 'g1', channels: {cache: new Map([['vc1', channel]])}};
  let destroyed = 0;
  const player = {guildId: 'g1', voiceChannelId: 'vc1', destroy: async () => { destroyed++; }};
  const manager = new EventEmitter();
  manager.getPlayer = () => player;
  const settings = {get: async () => ({autoplay: true, stayInVoice, volume: 50})};
  const service = new MusicService({manager}, {}, settings, 20, true, logger);
  const state = channelId => ({guild, channelId});
  return {
    service, members, state,
    get destroyed() { return destroyed; },
    join: id => members.set(id, {user: {bot: false}}),
    leave: id => members.delete(id)
  };
}

test('leaves the voice channel once only bots remain, even with autoplay', async () => {
  const ctx = setup();
  ctx.members.set('bot', {user: {bot: true}});
  await ctx.service.handleVoiceStateUpdate(ctx.state('vc1'), ctx.state(null));
  await wait(50);
  assert.equal(ctx.destroyed, 1);
});

test('cancels the departure when someone comes back before the timeout', async () => {
  const ctx = setup();
  await ctx.service.handleVoiceStateUpdate(ctx.state('vc1'), ctx.state(null));
  ctx.join('u1');
  await ctx.service.handleVoiceStateUpdate(ctx.state(null), ctx.state('vc1'));
  await wait(50);
  assert.equal(ctx.destroyed, 0);
});

test('stays while a human is still in the channel', async () => {
  const ctx = setup();
  ctx.join('u1');
  ctx.join('u2');
  ctx.leave('u2');
  await ctx.service.handleVoiceStateUpdate(ctx.state('vc1'), ctx.state(null));
  await wait(50);
  assert.equal(ctx.destroyed, 0);
});

test('24/7 mode keeps the bot in an empty channel', async () => {
  const ctx = setup({stayInVoice: true});
  await ctx.service.handleVoiceStateUpdate(ctx.state('vc1'), ctx.state(null));
  await wait(50);
  assert.equal(ctx.destroyed, 0);
});

test('ignores voice updates in other channels', async () => {
  const ctx = setup();
  await ctx.service.handleVoiceStateUpdate(ctx.state('other'), ctx.state(null));
  await wait(50);
  assert.equal(ctx.destroyed, 0);
});
