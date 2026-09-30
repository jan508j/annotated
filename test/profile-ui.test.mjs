import test from 'node:test';
import assert from 'node:assert/strict';
import { profileCount, takeFollowIntent } from '../web/profile-page.js';

test('profile counts stay readable at comma and compact boundaries', () => {
  for (const [count, label] of [[0,'0'],[1,'1'],[9999,'9,999'],[10000,'10k'],[12400,'12.4k'],[999999,'1M'],[1200000,'1.2M']]) assert.equal(profileCount(count),label);
});

test('a follow return requires a matching recent explicit intent, consumed once', () => {
  const values = new Map();
  const storage = { getItem: k => values.get(k), removeItem: k => values.delete(k) };
  const write = intent => values.set('annotated:follow-intent', JSON.stringify(intent));
  assert.equal(takeFollowIntent(storage,'a',1000),false);
  write({id:'a',at:1000});
  assert.equal(takeFollowIntent(storage,'b',2000),false);
  assert.equal(takeFollowIntent(storage,'a',2000),true);
  assert.equal(takeFollowIntent(storage,'a',2000),false);
  write({id:'a',at:1000});
  assert.equal(takeFollowIntent(storage,'a',901001),false);
  write({id:'a',at:4000});
  assert.equal(takeFollowIntent(storage,'a',2000),false);
  values.set('annotated:follow-intent','not JSON');
  assert.equal(takeFollowIntent(storage,'a',2000),false);
});
