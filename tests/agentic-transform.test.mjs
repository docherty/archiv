import assert from 'node:assert/strict';
import test from 'node:test';

await import('../extension/lib/agentic-transform.js');

const transform = globalThis.VeniceAgenticTransform;

const sampleMessage = {
  id: 'resp_abc123',
  mind_conversation_id: 'pP2P6tz',
  role: 'assistant',
  status: 'completed',
  created_at_unix_timestamp: 1717000000000,
  updated_at_unix_timestamp: 1717000005000,
  model: 'venice-uncensored',
  output_items: [
    {
      type: 'reasoning',
      content: [{ type: 'reasoning_text', text: 'The user wants the capital of France.' }]
    },
    {
      type: 'webSearch',
      query: 'capital of France',
      sources: [
        { url: 'https://example.com/paris', title: 'Paris - Wikipedia' },
        { title: 'No URL entry' }
      ]
    },
    {
      type: 'serverFunctionCall',
      name: 'lookup_city',
      call_id: 'call_1',
      arguments: '{"country":"France"}'
    },
    {
      type: 'serverFunctionCallOutput',
      call_id: 'call_1',
      output: '{"capital":"Paris"}'
    },
    {
      type: 'message',
      content: [{ type: 'output_text', text: 'The capital of France is Paris.' }]
    }
  ]
};

test('flattenOutputItems orders text, reasoning, and tool segments', () => {
  const { segments, text } = transform.flattenOutputItems(sampleMessage.output_items);

  assert.equal(text, 'The capital of France is Paris.');
  assert.deepEqual(segments.map((segment) => segment.type), [
    'reasoning',
    'tool',
    'tool',
    'tool',
    'text'
  ]);

  const search = segments[1];
  assert.equal(search.tool, 'web_search');
  assert.equal(search.query, 'capital of France');
  assert.equal(search.sources.length, 2);
  assert.equal(search.sources[0].url, 'https://example.com/paris');
  assert.equal(search.sources[1].url, null);
  assert.equal(search.sources[1].title, 'No URL entry');

  const call = segments[2];
  assert.equal(call.tool, 'lookup_city');
  assert.equal(call.phase, 'call');
  assert.deepEqual(call.arguments, { country: 'France' });

  const output = segments[3];
  assert.equal(output.tool, 'lookup_city');
  assert.equal(output.phase, 'output');
  assert.deepEqual(output.output, { capital: 'Paris' });
});

test('buildAgenticMessage produces a legacy-shaped record with segments', () => {
  const record = transform.buildAgenticMessage(sampleMessage);

  assert.equal(record.id, 'resp_abc123');
  assert.equal(record.conversationId, 'pP2P6tz');
  assert.equal(record.role, 'assistant');
  assert.equal(record.content, 'The capital of France is Paris.');
  assert.equal(record.modelName, 'venice-uncensored');
  assert.equal(record.createdAtUnixTimestamp, 1717000000000);
  assert.equal(record.source, 'agentic');
  assert.equal(record.agentSegments.length, 5);
});

test('buildAgenticConversation maps name and agent url', () => {
  const conversation = transform.buildAgenticConversation({
    id: 'pP2P6tz',
    name: 'Research session',
    createdAtUnixTimestamp: 1717000000000,
    updatedAtUnixTimestamp: 1717000009000
  });

  assert.equal(conversation.id, 'pP2P6tz');
  assert.equal(conversation.title, 'Research session');
  assert.equal(conversation.name, 'Research session');
  assert.equal(conversation.kind, 'agent');
  assert.equal(conversation.agentUrl, 'https://venice.ai/chat/agent/pP2P6tz');
});

test('buildAgenticConversations and buildAgenticMessages skip invalid records', () => {
  const conversations = transform.buildAgenticConversations([
    { id: 'a', name: 'Has id' },
    { name: 'No id' },
    null
  ]);
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].id, 'a');

  const messages = transform.buildAgenticMessages([
    sampleMessage,
    { id: 'no-conv' },
    null
  ]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].conversationId, 'pP2P6tz');
});

test('buildAgenticMediaRecords normalizes videos, media, and attachments', () => {
  const records = transform.buildAgenticMediaRecords({
    messageVideos: [
      { id: 'v1', url: 'https://cdn.example/video.mp4', conversationId: 'pP2P6tz', mimeType: 'video/mp4' },
      { id: 'v2' }
    ],
    mindMedia: [
      { id: 'm1', mediaUrl: 'https://cdn.example/image.png' }
    ],
    mindAttachments: [
      { id: 'a1', downloadUrl: 'https://cdn.example/file.pdf', filename: 'report.pdf' }
    ]
  });

  assert.equal(records.length, 4);

  const video = records.find((record) => record.id === 'v1');
  assert.equal(video.url, 'https://cdn.example/video.mp4');
  assert.equal(video.__mediaSource, 'messageVideos');
  assert.equal(video.__mediaDefaultKind, 'video');

  const placeholderVideo = records.find((record) => record.id === 'v2');
  assert.equal(placeholderVideo.url, null);
  assert.equal(placeholderVideo.__mediaDefaultKind, 'video');

  const attachment = records.find((record) => record.id === 'a1');
  assert.equal(attachment.url, 'https://cdn.example/file.pdf');
  assert.equal(attachment.fileName, 'report.pdf');
  assert.equal(attachment.__mediaDefaultKind, 'file');
});

test('buildAgenticMediaRecords retains OPFS-backed attachment metadata without a URL', () => {
  const records = transform.buildAgenticMediaRecords({
    messageAudioAttachments: [
      { id: 'audio-1', conversationId: 'chat-1', messageId: 'msg-1', mimeType: 'audio/mpeg' }
    ],
    messageFileAttachments: [
      { id: 'file-1', conversationId: 'chat-1', messageId: 'msg-1', filename: 'notes.pdf', mimeType: 'application/pdf' }
    ]
  });

  assert.equal(records.length, 2);
  assert.equal(records[0].url, null);
  assert.equal(records[0].__mediaDefaultKind, 'audio');
  assert.equal(records[1].fileName, 'notes.pdf');
  assert.equal(records[1].__mediaSource, 'messageFileAttachments');
});

test('flattenOutputItems tolerates empty or malformed input', () => {
  assert.deepEqual(transform.flattenOutputItems(null), { segments: [], text: '' });
  assert.deepEqual(transform.flattenOutputItems('not-an-array'), { segments: [], text: '' });

  const { segments, text } = transform.flattenOutputItems([
    { type: 'serverFunctionCall', name: 'orphan_output_only', arguments: 'not-json' }
  ]);
  assert.equal(text, '');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].tool, 'orphan_output_only');
  assert.equal(segments[0].arguments, 'not-json');
});
