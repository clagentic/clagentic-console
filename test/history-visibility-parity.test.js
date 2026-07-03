/**
 * Parity test for lr-c24b: assert that the CJS backend copy
 * (lib/history-visibility.js) and the ES module frontend copy
 * (lib/public/modules/history-visibility.js) expose identical
 * HIDDEN_TOOL_NAMES / INVISIBLE_TYPES sets and agree on isVisibleHistoryEvent()
 * for a representative event set.
 *
 * This test is the enforcement mechanism that prevents the two files from
 * silently drifting — it must remain green whenever a new WS message type or
 * hidden tool is added to either copy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Load the CJS backend copy synchronously via require().
const cjs = require('../lib/history-visibility.js');

// Load the ES module frontend copy via dynamic import().
const esm = await import('../lib/public/modules/history-visibility.js');

test('lr-c24b: HIDDEN_TOOL_NAMES set is identical in both copies', () => {
  const cjsKeys = Object.keys(cjs.HIDDEN_TOOL_NAMES).sort();
  const esmKeys = Object.keys(esm.HIDDEN_TOOL_NAMES).sort();
  assert.deepStrictEqual(cjsKeys, esmKeys,
    'Both copies must have the same HIDDEN_TOOL_NAMES keys');
});

test('lr-c24b: INVISIBLE_TYPES set is identical in both copies', () => {
  const cjsKeys = Object.keys(cjs.INVISIBLE_TYPES).sort();
  const esmKeys = Object.keys(esm.INVISIBLE_TYPES).sort();
  assert.deepStrictEqual(cjsKeys, esmKeys,
    'Both copies must have the same INVISIBLE_TYPES keys');
});

const TEST_EVENTS = [
  [{ type: 'user_message', text: 'hi' }, true, 'user_message'],
  [{ type: 'delta', text: 'hello' }, true, 'assistant delta'],
  [{ type: 'result', cost: 0.01 }, true, 'result'],
  [{ type: 'error', text: 'oops' }, true, 'error'],
  [{ type: 'context_preview', tab: {} }, true, 'context_preview'],
  [{ type: 'plan_content', content: 'plan' }, true, 'plan_content'],
  [{ type: 'slash_command_result', text: 'out' }, true, 'slash_command_result'],
  [{ type: 'tool_start', id: '1', name: 'Bash' }, true, 'tool_start (visible tool)'],
  [{ type: 'tool_executing', id: '1', name: 'Edit', input: {} }, true, 'tool_executing (visible tool)'],
  [{ type: 'message_uuid', uuid: 'x', messageType: 'user' }, false, 'message_uuid'],
  [{ type: 'session_id', cliSessionId: 'x' }, false, 'session_id'],
  [{ type: 'status', status: 'processing' }, false, 'status'],
  [{ type: 'compacting', active: true }, false, 'compacting'],
  [{ type: 'thinking_start' }, false, 'thinking_start'],
  [{ type: 'thinking_delta', text: 'hmm' }, false, 'thinking_delta'],
  [{ type: 'thinking_stop', duration: 1 }, false, 'thinking_stop'],
  [{ type: 'tool_start', id: '2', name: 'TodoWrite' }, false, 'tool_start (TodoWrite)'],
  [{ type: 'tool_executing', id: '2', name: 'TaskCreate', input: {} }, false, 'tool_executing (TaskCreate)'],
  [{ type: 'tool_start', id: '3', name: 'EnterPlanMode' }, false, 'tool_start (EnterPlanMode)'],
  [{ type: 'tool_result', id: '1', content: 'ok' }, false, 'tool_result (any tool)'],
  [{ type: 'ask_user_answered', toolId: '1' }, false, 'ask_user_answered'],
  [{ type: 'permission_request', requestId: '1' }, false, 'permission_request'],
  [{ type: 'subagent_activity', parentToolId: '1', text: 'x' }, false, 'subagent_activity'],
  [{ type: 'task_progress', parentToolId: '1' }, false, 'task_progress'],
  [{ type: 'done', code: 0 }, false, 'done'],
  [{ type: 'digest_checkpoint' }, false, 'digest_checkpoint'],
  [null, true, 'null entry defaults to visible'],
  [{}, true, 'entry with no type defaults to visible'],
];

for (const [entry, expected, label] of TEST_EVENTS) {
  test('lr-c24b: isVisibleHistoryEvent parity — ' + label, () => {
    const cjsResult = cjs.isVisibleHistoryEvent(entry);
    const esmResult = esm.isVisibleHistoryEvent(entry);
    assert.strictEqual(cjsResult, expected, `CJS classification for ${label}`);
    assert.strictEqual(esmResult, expected, `ESM classification for ${label}`);
    assert.strictEqual(cjsResult, esmResult, `CJS/ESM must agree for ${label}`);
  });
}
