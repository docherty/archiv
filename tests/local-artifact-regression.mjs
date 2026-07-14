import assert from 'node:assert/strict';
import fs from 'node:fs';

const archivePath = process.env.VENICE_ARCHIVE_FIXTURE;

const TARGET_CONVERSATION_ID = '1g8W9AY';
const TARGET_MESSAGE_ID = '36s6Iqo';
const TARGET_PHRASE = 'My mum has received the attached letter.';
const TARGET_MESSAGE_MARKER = `"id":"${TARGET_MESSAGE_ID}"`;
const TARGET_SCAN_LIMIT_BYTES = 32 * 1024 * 1024;
const TAIL_BYTES = 2048;

if (!archivePath) {
  console.log('local-artifact-regression: skipped; set VENICE_ARCHIVE_FIXTURE to a local readable-archive JSON fixture');
  process.exit(0);
}

if (!fs.existsSync(archivePath)) {
  console.log('local-artifact-regression: skipped; VENICE_ARCHIVE_FIXTURE does not exist');
  process.exit(0);
}

const literals = {
  archiveType: '"archiveType":"venice-history-archive"',
  targetConversationId: `"id":"${TARGET_CONVERSATION_ID}"`,
  targetConversationName: `"name":"${TARGET_PHRASE}`,
  targetMessageId: TARGET_MESSAGE_MARKER,
  targetMessageContent: `"content":"${TARGET_PHRASE}`,
  attachments: '"attachments"',
  resultPayloads: '"result":"',
  contentBinary: '"contentBinary"',
  sourceUrls: '"sourceUrl"',
  blobUrls: 'blob:'
};

const counts = Object.fromEntries(Object.keys(literals).map((key) => [key, 0]));
const targetWindow = {
  found: false,
  bytesScanned: 0,
  attachments: 0,
  resultPayloads: 0,
  imageMimeTypes: 0,
  truncated: false
};

function countNewLiteral(combined, literal, previousTailLength) {
  let count = 0;
  let index = combined.indexOf(literal);
  while (index !== -1) {
    if (index + literal.length > previousTailLength) {
      count += 1;
    }
    index = combined.indexOf(literal, index + literal.length);
  }
  return count;
}

function trimTail(value) {
  return value.length > TAIL_BYTES ? value.slice(-TAIL_BYTES) : value;
}

let generalTail = '';
let targetSearchTail = '';
let targetScanTail = '';
let targetActive = false;

function scanTargetText(text) {
  if (!text || targetWindow.bytesScanned >= TARGET_SCAN_LIMIT_BYTES) {
    return;
  }

  const remaining = TARGET_SCAN_LIMIT_BYTES - targetWindow.bytesScanned;
  const segment = text.length > remaining ? text.slice(0, remaining) : text;
  const combined = targetScanTail + segment;
  const previousTailLength = targetScanTail.length;

  targetWindow.attachments += countNewLiteral(combined, '"attachments"', previousTailLength);
  targetWindow.resultPayloads += countNewLiteral(combined, '"result":"', previousTailLength);
  targetWindow.imageMimeTypes += countNewLiteral(combined, 'image/', previousTailLength);
  targetWindow.bytesScanned += Buffer.byteLength(segment);
  targetScanTail = trimTail(combined);

  if (text.length > remaining) {
    targetWindow.truncated = true;
    targetActive = false;
  }
}

const stream = fs.createReadStream(archivePath, {
  encoding: 'utf8',
  highWaterMark: 1024 * 1024
});

for await (const chunk of stream) {
  const text = String(chunk);
  const combined = generalTail + text;
  const previousTailLength = generalTail.length;

  for (const [key, literal] of Object.entries(literals)) {
    counts[key] += countNewLiteral(combined, literal, previousTailLength);
  }

  if (targetActive) {
    scanTargetText(text);
  } else if (!targetWindow.found) {
    const searchCombined = targetSearchTail + text;
    const markerIndex = searchCombined.indexOf(TARGET_MESSAGE_MARKER);
    if (markerIndex !== -1) {
      targetWindow.found = true;
      targetActive = true;
      scanTargetText(searchCombined.slice(markerIndex));
    }
    targetSearchTail = trimTail(searchCombined);
  }

  generalTail = trimTail(combined);
}

assert.ok(counts.archiveType >= 1, 'archive marker should be present');
assert.ok(counts.targetConversationId >= 1, 'target conversation id should be present');
assert.ok(counts.targetConversationName >= 1, 'target conversation name should be present for title fallback regression');
assert.ok(counts.targetMessageContent >= 1, 'target message content should be present');
assert.ok(counts.attachments >= 1, 'archive should include attachment fields');
assert.ok(counts.resultPayloads >= 1, 'archive should include embedded attachment result payloads');
assert.ok(targetWindow.found, 'target message should be found');
assert.ok(targetWindow.resultPayloads >= 2, 'target message window should include at least two embedded attachment payloads');

console.log('local-artifact-regression: ok', JSON.stringify({
  archivePath,
  counts,
  targetWindow
}, null, 2));
