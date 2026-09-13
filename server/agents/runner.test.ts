/**
 * Tests for the part of the runner that decides what a paused task may resume from.
 *
 *   npm test
 *
 * Resuming the wrong thing is worse than restarting: a conversation where the model asked for
 * tools that were never answered is a protocol error, and the provider rejects the whole run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resumable } from './runner.ts';
import type { Msg } from '../llm.ts';

const system: Msg = { role: 'system', content: 'you are an agent' };
const user: Msg = { role: 'user', content: 'Task #1: do the thing' };
const assistantWith = (...ids: string[]): Msg => ({
  role: 'assistant',
  content: null,
  tool_calls: ids.map((id) => ({ id, type: 'function' as const, function: { name: 'read_file', arguments: '{}' } })),
});
const toolResult = (id: string): Msg => ({ role: 'tool', tool_call_id: id, content: 'ok' });

test('a conversation that ends on answered tool calls is kept whole', () => {
  const messages = [system, user, assistantWith('a', 'b'), toolResult('a'), toolResult('b')];
  assert.deepEqual(resumable(messages), messages);
});

test('an assistant turn whose tool calls went unanswered is dropped', () => {
  const messages = [system, user, assistantWith('a', 'b'), toolResult('a')];
  assert.deepEqual(resumable(messages), [system, user]);
});

test('only the trailing turn is examined, so earlier complete turns survive', () => {
  const good = [system, user, assistantWith('a'), toolResult('a')];
  const messages = [...good, assistantWith('b')];
  assert.deepEqual(resumable(messages), good);
});

test('a plain assistant reply with no tool calls is kept', () => {
  const messages = [system, user, { role: 'assistant', content: 'done' } as Msg];
  assert.deepEqual(resumable(messages), messages);
});

test('a conversation with nothing but the opening turns is returned unchanged', () => {
  assert.deepEqual(resumable([system, user]), [system, user]);
});

test('an empty conversation stays empty rather than throwing', () => {
  assert.deepEqual(resumable([]), []);
});
