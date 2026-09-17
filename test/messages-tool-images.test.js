import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessages } from '../src/handlers/messages.js';
import { normalizeMessagesForCascade } from '../src/handlers/tool-emulation.js';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import { getField, getAllFields, parseFields } from '../src/proto.js';

const image = (data = 'AAAA', mime = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mime, data } });
const use = (id, name = 'Screenshot') => ({ type: 'tool_use', id, name, input: {} });
const result = (id, content, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });
const bodyFor = (content, name = 'Screenshot', extra = {}) => ({
  model: 'swe-1-7', system: 'Inspect tool images.', messages: [
    { role: 'user', content: 'Describe the picture.' },
    { role: 'assistant', content: [use('a', name)] },
    { role: 'user', content: [result('a', content, extra)] },
  ],
});
async function convert(body) {
  let converted;
  await handleMessages(body, { handleChatCompletions: async b => {
    converted = b;
    return { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] } };
  } });
  return converted;
}
function wire(body) {
  const request = buildGetChatMessageRequest({ token: 'offline-test', model: body.model,
    messages: normalizeMessagesForCascade(body.messages, body.tools || [], {
      nativeStructured: true, stripOrphans: true, injectUserPreamble: false,
    }), nativeToolCall: true, env: {} });
  return getAllFields(parseFields(request), 3).map(f => parseFields(f.value));
}
const text = cm => getField(cm, 3, 2)?.value.toString() || '';
const images = cm => getAllFields(cm, 10).map(f => {
  const fields = parseFields(f.value);
  return { data: getField(fields, 1, 2)?.value.toString(), mime: getField(fields, 2, 2)?.value.toString() };
});

describe('Anthropic tool-result images reach Devin wire', () => {
  it('keeps real pixels, MIME and call linkage for an image-only result', async () => {
    const converted = await convert(bodyFor([image()]));
    const msg = converted.messages.find(m => m.role === 'tool');
    assert.deepEqual(msg.content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
    const cm = wire(converted).find(cm => getField(cm, 7, 2)?.value.toString() === 'a');
    assert.equal(Number(getField(cm, 2, 0)?.value), 4);
    assert.deepEqual(images(cm), [{ data: 'AAAA', mime: 'image/png' }]);
    assert.ok(!text(cm).includes('AAAA'), 'base64 must not become prompt text');
  });

  it('preserves text before and after multiple images', async () => {
    const converted = await convert(bodyFor([{ type: 'text', text: 'Before' }, image(),
      { type: 'text', text: 'Between' }, image('BBBB', 'image/jpeg'), { type: 'text', text: 'After' }]));
    const cm = wire(converted).find(cm => getField(cm, 7, 2));
    assert.equal(text(cm), 'Before\nBetween\nAfter');
    assert.deepEqual(images(cm), [{ data: 'AAAA', mime: 'image/png' }, { data: 'BBBB', mime: 'image/jpeg' }]);
  });

  it('keeps each image with its matching parallel call and does not mutate input', async () => {
    const body = bodyFor([]);
    body.messages[1].content = [use('a'), use('b')];
    body.messages[2].content = [result('b', [image('BBBB')]), result('a', [image('AAAA')]), { type: 'text', text: 'Compare them.' }];
    const before = structuredClone(body);
    const cms = wire(await convert(body));
    const results = cms.filter(cm => getField(cm, 7, 2));
    assert.deepEqual(results.map(cm => [getField(cm, 7, 2).value.toString(), images(cm)[0]?.data]), [['a', 'AAAA'], ['b', 'BBBB']]);
    assert.deepEqual(body, before);
    assert.equal(text(cms.at(-1)), 'Compare them.');
  });

  it('keeps Read truncation annotations without replacing image parts', async () => {
    const converted = await convert(bodyFor([{ type: 'text', text: 'File content unchanged (cached).' }, image()], 'Read'));
    const cm = wire(converted).find(cm => getField(cm, 7, 2));
    assert.match(text(cm), /does not prove the full file body/);
    assert.equal(images(cm).length, 1);
  });

  it('preserves images from error tool results too', async () => {
    const cms = wire(await convert(bodyFor([{ type: 'text', text: 'Action failed; current screen follows.' }, image()], 'Screenshot', { is_error: true })));
    const cm = cms.find(cm => getField(cm, 7, 2));
    assert.match(text(cm), /Action failed/);
    assert.equal(images(cm).length, 1);
  });

  it('keeps text-only results as strings', async () => {
    for (const [content, expected] of [['plain', 'plain'], [[{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], 'one\ntwo'], [[], '']]) {
      const converted = await convert(bodyFor(content));
      assert.equal(converted.messages.find(m => m.role === 'tool').content, expected);
    }
  });

  it('uses the same remote-URL normalization as user attachments', async () => {
    const converted = await convert(bodyFor([{ type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } }]));
    assert.deepEqual(converted.messages.find(m => m.role === 'tool').content,
      [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }]);
  });

  it('retains an explicit placeholder for malformed image sources', async () => {
    const converted = await convert(bodyFor([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg' } }]));
    assert.match(JSON.stringify(converted.messages.find(m => m.role === 'tool').content), /\[image: image\/jpeg\]/);
  });

  it('leaves direct user attachments working', async () => {
    const converted = await convert({ model: 'swe-1-7', messages: [{ role: 'user', content: [image()] }] });
    assert.deepEqual(images(wire(converted)[0]), [{ data: 'AAAA', mime: 'image/png' }]);
  });
});
