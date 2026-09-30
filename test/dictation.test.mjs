import test from 'node:test';
import assert from 'node:assert/strict';
import { createDictation } from '../extension/dictation.mjs';

class Recognition {
  static instances = [];

  constructor() {
    this.starts = 0;
    this.stops = 0;
    this.aborts = 0;
    Recognition.instances.push(this);
  }

  start() { this.starts += 1; }
  stop() { this.stops += 1; }
  abort() { this.aborts += 1; }
  result(...items) {
    this.onresult?.({ results: items.map(([transcript, isFinal]) => ({ 0: { transcript }, isFinal })) });
  }
}

function textarea(value = '', start = value.length, end = start, maxLength = 2000) {
  return {
    value, selectionStart: start, selectionEnd: end, maxLength, inputs: 0,
    setSelectionRange(nextStart, nextEnd) { this.selectionStart = nextStart; this.selectionEnd = nextEnd; },
    dispatchEvent(event) { if (event.type === 'input') this.inputs += 1; }
  };
}

function setup(options = {}) {
  Recognition.instances.length = 0;
  const states = [];
  const errors = [];
  const permissions = [];
  const field = options.textarea || textarea();
  const dictation = createDictation({
    Recognition,
    textarea: field,
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
    onPermissionNeeded: (error) => permissions.push(error),
    lang: options.lang || 'en-US',
    maxDurationMs: options.maxDurationMs || 90_000,
    startTimeoutMs: options.startTimeoutMs
  });
  return { dictation, field, states, errors, permissions };
}

test('creates no recognizer or microphone session before an explicit start', () => {
  const { dictation, states } = setup();
  assert.equal(dictation.supported, true);
  assert.equal(dictation.active, false);
  assert.equal(Recognition.instances.length, 0);
  assert.deepEqual(states, []);
  assert.equal(dictation.start(), true);
  assert.equal(Recognition.instances[0].starts, 1);
  assert.equal(dictation.active, true);
  assert.deepEqual(states[0], { status: 'starting', interim: '' });
  dictation.abort();
});

test('inserts final text at the caret, keeps surrounding text, and does not duplicate interim or final results', () => {
  const field = textarea('Hello world', 5);
  const { dictation, states } = setup({ textarea: field });
  dictation.start();
  const recognition = Recognition.instances[0];
  recognition.onstart();
  recognition.result(['there', false]);
  assert.equal(field.value, 'Hello world');
  assert.deepEqual(states.at(-1), { status: 'listening', interim: 'there' });
  recognition.result(['there', true]);
  recognition.result(['there', true], ['friend', false]);
  assert.equal(field.value, 'Hello there world');
  assert.equal(field.selectionStart, 11);
  assert.equal(field.inputs, 1);
  assert.deepEqual(states.at(-1), { status: 'listening', interim: 'friend' });
  recognition.result(['there', true], ['friend', true]);
  assert.equal(field.value, 'Hello there friend world');
  assert.equal(field.inputs, 2);
  dictation.abort();
});

test('replaces selected text and respects the 2000-character limit with a warning', () => {
  const field = textarea(`${'a'.repeat(1994)}xxxx`, 1994, 1998);
  const { dictation, errors } = setup({ textarea: field });
  dictation.start();
  Recognition.instances[0].result(['a spoken phrase', true]);
  assert.equal(field.value.length, 2000);
  assert.equal(field.value.slice(-6), ' a spo');
  assert.equal(field.selectionStart, 2000);
  assert.deepEqual(errors.map((error) => error.code), ['max-length']);
  dictation.abort();
});

test('stop accepts a late final result, then end returns to idle', () => {
  const { dictation, field, states, errors } = setup();
  dictation.start();
  const recognition = Recognition.instances[0];
  assert.equal(dictation.stop(), true);
  assert.equal(recognition.stops, 1);
  assert.deepEqual(states.at(-1), { status: 'stopping', interim: '' });
  recognition.result(['final words', true]);
  recognition.onend();
  assert.equal(field.value, 'final words');
  assert.equal(dictation.active, false);
  assert.deepEqual(states.at(-1), { status: 'idle', interim: '' });
  assert.deepEqual(errors, []);
});

test('abort discards late recognition results and permits a fresh session', () => {
  const { dictation, field, errors, permissions } = setup();
  dictation.start();
  const old = Recognition.instances[0];
  assert.equal(dictation.abort(), true);
  assert.equal(old.aborts, 1);
  old.result(['must disappear', true]);
  old.onnomatch();
  old.onerror({ error: 'not-allowed' });
  old.onend();
  assert.equal(field.value, '');
  dictation.start();
  Recognition.instances[1].result(['new words', true]);
  assert.equal(field.value, 'new words');
  dictation.abort();
  assert.deepEqual(errors, []);
  assert.deepEqual(permissions, []);
});

test('empty and interim-only recognition ends report guidance without inserting unfinished text', () => {
  for (const interim of ['', 'unfinished words']) {
    const { dictation, field, states, errors } = setup();
    dictation.start();
    const recognition = Recognition.instances[0];
    recognition.onstart();
    if (interim) recognition.result([interim, false]);
    recognition.onend();
    recognition.onend();
    assert.equal(dictation.active, false);
    assert.equal(field.value, '');
    assert.deepEqual(states.at(-1), { status: 'idle', interim: '' });
    assert.deepEqual(errors.map(error => error.code), ['no-transcript']);
    assert.match(errors[0].message, /language.*microphone/i);
  }
});

test('a successful final transcript ends without an empty-session warning', () => {
  const { dictation, field, errors } = setup();
  dictation.start();
  const recognition = Recognition.instances[0];
  recognition.result(['recognized words', true]);
  recognition.onend();
  assert.equal(field.value, 'recognized words');
  assert.deepEqual(errors, []);
});

test('nomatch reports language and input guidance once and ignores late results', () => {
  const { dictation, field, errors } = setup();
  dictation.start();
  const recognition = Recognition.instances[0];
  recognition.onnomatch();
  recognition.result(['late words', true]);
  recognition.onend();
  assert.equal(dictation.active, false);
  assert.equal(recognition.aborts, 1);
  assert.equal(field.value, '');
  assert.deepEqual(errors.map(error => error.code), ['no-match']);
  assert.match(errors[0].message, /language.*microphone/i);
});

test('stop without final text reports guidance while preserving the existing take', () => {
  const { dictation, field, errors } = setup({ textarea: textarea('Existing take') });
  dictation.start();
  const recognition = Recognition.instances[0];
  recognition.onstart();
  recognition.result(['unfinished words', false]);
  dictation.stop();
  recognition.onend();
  assert.equal(field.value, 'Existing take');
  assert.deepEqual(errors.map(error => error.code), ['no-transcript']);
});

test('a stuck stop aborts after its grace period and reports missing final text', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { dictation, errors } = setup();
  dictation.start();
  const recognition = Recognition.instances[0];
  recognition.onstart();
  dictation.stop();
  context.mock.timers.tick(1500);
  assert.equal(dictation.active, false);
  assert.equal(recognition.aborts, 1);
  assert.deepEqual(errors.map(error => error.code), ['no-transcript']);
});

test('a recognizer that never starts times out and cannot affect a fresh session', async () => {
  const { dictation, field, errors } = setup({ startTimeoutMs: 5 });
  dictation.start();
  const old = Recognition.instances[0];
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(dictation.active, false);
  assert.equal(old.aborts, 1);
  assert.deepEqual(errors.map(error => error.code), ['start-timeout']);
  dictation.start();
  const current = Recognition.instances[1];
  current.onstart();
  old.onstart();
  old.result(['stale words', true]);
  old.onend();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(dictation.active, true);
  current.result(['new words', true]);
  current.onend();
  assert.equal(field.value, 'new words');
  assert.deepEqual(errors.map(error => error.code), ['start-timeout']);
});

test('intentional abort cancels the startup deadline silently', async () => {
  const { dictation, errors } = setup({ startTimeoutMs: 5 });
  dictation.start();
  dictation.abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(errors, []);
});

test('permission and service failures are routed separately from network and no-speech errors', () => {
  for (const code of ['not-allowed', 'service-not-allowed', 'network', 'no-speech', 'audio-capture', 'language-not-supported']) {
    const { dictation, errors, permissions } = setup();
    dictation.start();
    const recognition = Recognition.instances[0];
    recognition.onerror({ error: code });
    recognition.onend();
    assert.equal(dictation.active, false);
    assert.equal(recognition.aborts, 1);
    assert.deepEqual(permissions.map((error) => error.code), code.includes('allowed') ? [code] : []);
    assert.deepEqual(errors.map((error) => error.code), code.includes('allowed') ? [] : [code]);
  }
});

test('constructor and start failures leave the controller idle', () => {
  class BrokenConstructor { constructor() { throw new Error('construction failed'); } }
  const errors = [];
  const broken = createDictation({ Recognition: BrokenConstructor, textarea: textarea(), onError: (error) => errors.push(error) });
  assert.equal(broken.start(), false);
  assert.equal(broken.active, false);
  assert.equal(errors[0].code, 'start-failed');

  class BrokenStart extends Recognition { start() { throw new Error('start failed'); } }
  const other = createDictation({ Recognition: BrokenStart, textarea: textarea(), onError: (error) => errors.push(error) });
  assert.equal(other.start(), false);
  assert.equal(other.active, false);
  assert.equal(errors.at(-1).code, 'start-failed');
});

test('unsupported recognition and a failed stop report errors without leaving an active session', () => {
  const errors = [];
  const unavailable = createDictation({ Recognition: null, textarea: textarea(), onError: (error) => errors.push(error) });
  assert.equal(unavailable.supported, false);
  assert.equal(unavailable.start(), false);
  assert.equal(errors.at(-1).code, 'unsupported');

  class BrokenStop extends Recognition { stop() { throw new Error('stop failed'); } }
  const dictation = createDictation({ Recognition: BrokenStop, textarea: textarea(), onError: (error) => errors.push(error) });
  dictation.start();
  assert.equal(dictation.stop(), false);
  assert.equal(dictation.active, false);
  assert.equal(errors.at(-1).code, 'stop-failed');
});

test('timer bounds dictation and ends stuck stop after its grace period', async () => {
  const { dictation, errors } = setup({ maxDurationMs: 5 });
  dictation.start();
  const recognition = Recognition.instances[0];
  recognition.onstart();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recognition.stops, 1);
  assert.deepEqual(errors.map((error) => error.code), ['time-limit']);
  recognition.onend();
  assert.equal(dictation.active, false);
});
