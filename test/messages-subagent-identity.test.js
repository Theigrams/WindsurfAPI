import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages, neutralizeClientIdentity } from '../src/handlers/messages.js';

const identity = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const agentIdentity = "You are an agent for Claude Code, Anthropic's official CLI for Claude.";
const environment = 'You are powered by the model named Opus 5 (1M context). The exact model ID is claude-opus-5[1m]. Assistant knowledge cutoff is May 2026.';
const style = 'For clear communication with the user the assistant MUST avoid using emojis.';
const originalFlag = process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID;
afterEach(() => {
  if (originalFlag === undefined) delete process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID;
  else process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = originalFlag;
});

async function convert(body) {
  let converted;
  await handleMessages({ model: 'swe-1-7', ...body }, {
    handleChatCompletions: async input => {
      converted = input;
      return { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } };
    },
  });
  return converted;
}

describe('Claude Code subagent identity conversion', () => {
  it('handles complete SDK and subagent identity sentences without dropping instructions', () => {
    const input = `${identity}\n${agentIdentity} Complete the task.\nAnalyze Claude Code and Anthropic model names.`;
    const expected = 'You are an AI coding assistant.\nYou are an AI coding assistant. Complete the task.\nAnalyze Claude Code and Anthropic model names.';
    assert.equal(neutralizeClientIdentity(input), expected);
    assert.equal(neutralizeClientIdentity(expected), expected);
  });

  for (const role of ['system', 'developer']) for (const array of [false, true]) {
    it(`processes original ${role} text before legacy role conversion (array=${array})`, async () => {
      const text = `# Environment\n${environment}\nKeep the tool instructions.`;
      const body = { system: identity, messages: [{ role, content: array ? [{ type: 'text', text }] : text }] };
      const before = structuredClone(body);
      const out = await convert(body);
      assert.equal(out.messages[0].content, 'You are an AI coding assistant.');
      assert.equal(out.messages[1].role, 'user');
      assert.equal(out.messages[1].content, '# Environment\nAssistant knowledge cutoff is May 2026.\nKeep the tool instructions.');
      assert.deepEqual(body, before);
    });
  }

  it('preserves task text, assistant history, tool arguments and results containing identity examples', async () => {
    const task = `Analyze this exact source string: ${identity}\n${environment}\n${style}`;
    const out = await convert({ messages: [
      { role: 'user', content: task },
      { role: 'assistant', content: [{ type: 'text', text: identity }, { type: 'tool_use', id: 'call-1', name: 'lookup', input: { source: task } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: environment }] },
    ] });
    assert.equal(out.messages[0].content, task);
    assert.equal(out.messages[1].content, identity);
    assert.deepEqual(JSON.parse(out.messages[1].tool_calls[0].function.arguments), { source: task });
    assert.equal(out.messages[2].content, environment);
    assert.equal(out.messages[2].tool_call_id, 'call-1');
  });

  it('preserves the no-emoji requirement and adjacent instructions with narrowly scoped wording', () => {
    const source = `Notes:\n- ${style} Keep answers concise.\n- Do not change files.`;
    const expected = 'Notes:\n- Use plain text without emojis when communicating with the user. Keep answers concise.\n- Do not change files.';
    assert.equal(neutralizeClientIdentity(source), expected);
    assert.equal(neutralizeClientIdentity(expected), expected);
    assert.equal(neutralizeClientIdentity(`Analyze the source string "${style}"`), `Analyze the source string "${style}"`);
    process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = '0';
    assert.equal(neutralizeClientIdentity(source), source);
  });

  it('honors the existing opt-out for both top-level and historical system content', async () => {
    process.env.WINDSURFAPI_NEUTRALIZE_CLIENT_ID = '0';
    const out = await convert({ system: identity, messages: [{ role: 'system', content: environment }] });
    assert.equal(out.messages[0].content, identity);
    assert.equal(out.messages[1].content, environment);
  });
});
