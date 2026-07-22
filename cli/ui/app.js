const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const APP_BUILD = '0.7.16-local';
const MEDIA_PAGE_SIZE = 120;
const IMAGE_ZOOM_STEPS = [12.5, 16.7, 25, 33.3, 50, 66.7, 100, 125, 150, 200, 300, 400, 600, 800];

const state = {
  view: 'home',
  overview: null,
  capabilities: {},
  serviceBuild: null,
  conversation: null,
  conversationFilter: { q: '', kind: 'all', sort: 'recent' },
  mediaFilter: { q: '', kind: 'all', source: 'all', uploads: false, favourites: false, showHidden: false, sort: 'recent' },
  mediaLimit: MEDIA_PAGE_SIZE,
  mediaData: null,
  mediaContext: [],
  mediaItem: null,
  mediaIndex: -1,
  mediaDetailsOpen: true,
  mediaZoomPercent: 100,
  mediaNavigatorCollapsed: false,
  mediaPan: null,
  mediaDragged: false,
  mediaPendingRemoval: null,
  mediaPendingHiddenRemovals: [],
  hiddenSurfaceNeedsRefresh: false,
  navigatorPan: null,
  mediaOrigin: null,
  returnToMedia: false,
  search: { q: '', type: 'all', data: null, selected: null, wholeWord: false, browseAll: false },
  sync: null,
  syncTimer: null,
  lastNotifiedSync: null,
  updateNoticeShown: false,
  modalReturnFocus: null,
  drawerReturnFocus: null,
  messageText: new Map(),
  renderQueue: Promise.resolve()
};

const main = $('#main');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const domId = (value) => String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '-');
const fmtNumber = (value) => new Intl.NumberFormat().format(Number(value || 0));
const plural = (count, singular, pluralForm = `${singular}s`) => `${fmtNumber(count)} ${count === 1 ? singular : pluralForm}`;
const fmtBytes = (value) => {
  const bytes = Number(value || 0);
  if (!bytes) return 'Size unavailable';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** index).toFixed(index && bytes < 10 * 1024 ** index ? 1 : 0)} ${units[index]}`;
};
const dateObject = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const fmtDate = (value) => {
  const date = dateObject(value);
  return date ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(date) : 'Date unavailable';
};
const fmtDateTime = (value) => {
  const date = dateObject(value);
  return date ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) : 'Date unavailable';
};
const fmtRelative = (value) => {
  const date = dateObject(value);
  if (!date) return 'Never';
  const delta = (date - Date.now()) / 1000;
  for (const [unit, seconds] of [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]]) {
    if (Math.abs(delta) >= seconds || unit === 'second') return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(delta / seconds), unit);
  }
};
const fmtDuration = (value) => {
  const milliseconds = Number(value || 0);
  if (!milliseconds) return null;
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
};

async function api(url, options) {
  const response = await fetch(url, options);
  const rawBody = await response.text();
  let body = null;
  if (rawBody) {
    try { body = JSON.parse(rawBody); } catch { body = null; }
  }
  if (!response.ok) {
    const pathname = new URL(url, location.href).pathname;
    if (response.status === 404 && ['/api/favourites', '/api/hidden'].includes(pathname)) {
      throw new Error('Restart Archiv to finish enabling media preferences. The page is newer than the running local service.');
    }
    throw new Error(body?.error || rawBody.trim() || `Request failed (${response.status})`);
  }
  if (body === null) throw new Error('The local service returned an unreadable response. Restart Archiv and try again.');
  return body;
}

function hasCapability(name) {
  return state.capabilities?.[name] === true;
}

function requireCapability(name, feature) {
  if (hasCapability(name)) return true;
  toast(`Restart Archiv to use ${feature}. The page is newer than the running local service (${state.serviceBuild || 'unknown build'}).`);
  return false;
}

function uiIcon(name, className = '') {
  return `<svg${className ? ` class="${esc(className)}"` : ''} aria-hidden="true"><use href="#icon-${esc(name)}"/></svg>`;
}

function infoIcon() {
  return uiIcon('info');
}

function starIcon() {
  return uiIcon('star');
}

const closeIcon = () => uiIcon('close');
const panelIcon = () => uiIcon('panel');

function updateRouteChrome(view) {
  $$('.nav-item').forEach((button) => {
    const active = button.dataset.nav === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.body.dataset.view = view;
  const contextTitle = $('#contextTitle');
  contextTitle.textContent = ({ conversations: 'Conversations', media: 'Media', archive: 'Archive status' })[view] || '';
  contextTitle.hidden = !['conversations', 'media', 'archive'].includes(view);
  $('#wholeWordToggle').setAttribute('aria-pressed', String(state.search.wholeWord));
  document.title = `${({ home: 'Library', conversations: 'Conversations', media: 'Media', search: 'Search', archive: 'Archive status' })[view]} · Archiv`;
}

function updateRouteUrl(view) {
  const url = new URL(location.href);
  url.hash = view;
  if (view === 'search') {
    if (state.search.q) url.searchParams.set('q', state.search.q);
    else url.searchParams.delete('q');
    if (state.search.type !== 'all') url.searchParams.set('type', state.search.type);
    else url.searchParams.delete('type');
    if (state.search.wholeWord) url.searchParams.set('whole', '1');
    else url.searchParams.delete('whole');
    if (state.search.browseAll) url.searchParams.set('browse', 'all');
    else url.searchParams.delete('browse');
  } else {
    url.searchParams.delete('q');
    url.searchParams.delete('type');
    url.searchParams.delete('whole');
    url.searchParams.delete('browse');
  }
  history.replaceState(null, '', url);
}

function nav(view) {
  if (view === 'search') {
    const visibleQuery = $('#globalSearchInput').value.trim();
    if (visibleQuery !== state.search.q) {
      state.search.q = visibleQuery;
      state.search.browseAll = false;
      state.search.selected = null;
    }
  } else {
    state.search = { ...state.search, q: '', type: 'all', data: null, selected: null, browseAll: false };
    $('#globalSearchInput').value = '';
  }
  state.view = view;
  updateRouteUrl(view);
  updateRouteChrome(view);
  closeNavigation();
  window.scrollTo({ top: 0, left: 0 });
  main.scrollTop = 0;
  state.renderQueue = state.renderQueue.catch(() => {}).then(render);
  main.focus({ preventScroll: true });
}

function conversationRow(item) {
  const selected = state.conversation?.id === item.id;
  return `<button class="conversation-row${selected ? ' selected' : ''}" data-conversation="${esc(item.id)}"${selected ? ' aria-current="true"' : ''}>
    <div class="row-top"><span class="row-title">${esc(item.title)}</span><span class="row-date">${fmtRelative(item.updatedAt)}</span></div>
    <div class="row-preview">${esc(item.preview || 'No preview available')}</div>
    <div class="row-meta">${plural(item.messageCount, 'message')} · ${plural(item.mediaCount, 'file')}${item.models?.[0] ? ` · ${esc(item.models[0])}` : ''}</div>
  </button>`;
}

function mediaVisual(item) {
  if (item.available && item.kind === 'image') return `<img src="${esc(item.fileUrl)}" loading="lazy" alt="${esc(item.fileName || 'Archived image')}">`;
  if (item.available && item.kind === 'video') return `<video src="${esc(item.fileUrl)}#t=0.1" preload="metadata" muted playsinline></video>`;
  const label = item.fileName || item.title || item.kind;
  const iconName = ({ audio: 'audio', video: 'play', file: 'file' })[item.kind] || 'file';
  return `<div class="media-fallback"><span class="file-glyph">${uiIcon(iconName)}</span><strong>${esc(label)}</strong></div>`;
}

function mediaCard(item) {
  const starLabel = item.isFavourite ? 'Unstar this item' : 'Star this item';
  return `<article class="media-card-shell${item.isHidden ? ' is-hidden' : ''}" data-media-card="${esc(item.id)}">
    <button class="media-card ${item.kind === 'file' ? 'file-card' : ''}" data-media="${esc(item.id)}" aria-label="Open ${esc(item.fileName || item.kind)}">${mediaVisual(item)}${item.kind !== 'image' ? `<span class="media-badge">${esc(item.kind)}</span>` : ''}${item.isHidden ? '<span class="hidden-media-badge">Hidden</span>' : ''}</button>
    <button class="media-favourite-button${item.isFavourite ? ' active' : ''}" data-favourite-media="${esc(item.id)}" type="button" aria-pressed="${Boolean(item.isFavourite)}" aria-label="${starLabel}" title="${starLabel}">${starIcon()}</button>
    <button class="media-info-button" data-media-info="${esc(item.id)}" aria-label="Show details for ${esc(item.fileName || item.kind)}">${infoIcon()}</button>
  </article>`;
}

function mediaFileActions(item, className = '') {
  if (!item.available) return '';
  const downloadUrl = item.downloadUrl || `/api/download/${encodeURIComponent(item.id)}`;
  return `<div class="media-file-actions${className ? ` ${esc(className)}` : ''}">
    <a href="${esc(downloadUrl)}" download="${esc(item.fileName || '')}" aria-label="Download ${esc(item.fileName || item.kind)}">${uiIcon('download')}<span>Download</span></a>
    <button type="button" data-reveal-media="${esc(item.id)}" aria-label="Show ${esc(item.fileName || item.kind)} in its folder">${uiIcon('folder')}<span>Show in folder</span></button>
  </div>`;
}

function inlineAudioPlayer(item) {
  const label = item.fileName || item.title || 'Archived audio';
  return `<div class="inline-audio-player" tabindex="-1" role="group" aria-label="Audio preview for ${esc(label)}">
    <div class="inline-audio-head">
      <span class="inline-audio-icon" aria-hidden="true">${uiIcon('audio')}</span>
      <div class="inline-audio-copy"><span>Audio</span><strong title="${esc(label)}">${esc(label)}</strong></div>
      <button class="inline-audio-details" type="button" data-media="${esc(item.id)}" aria-label="Open details for ${esc(label)}" title="Open details">${infoIcon()}</button>
    </div>
    <audio src="${esc(item.fileUrl)}" controls preload="metadata" aria-label="Play ${esc(label)}">Audio preview unavailable.</audio>
  </div>`;
}

function inlineMediaCard(item) {
  const disposition = ['input', 'output'].includes(item.mediaDisposition) ? item.mediaDisposition : null;
  const model = disposition === 'output' ? item.model : null;
  const metadata = model
    ? `<div class="inline-media-meta"><span>Model</span><strong${item.modelId && item.modelId !== model ? ` title="Model ID: ${esc(item.modelId)}"` : ''}>${esc(model)}</strong></div>`
    : '';
  const width = Number(item.width || 0);
  const height = Number(item.height || 0);
  const aspect = width > 0 && height > 0 ? `${width} / ${height}` : item.kind === 'video' ? '16 / 9' : '4 / 3';
  const preview = item.available && item.kind === 'audio'
    ? inlineAudioPlayer(item)
    : `<button class="inline-media-card" data-media="${esc(item.id)}" aria-label="Open ${esc(item.fileName || item.kind)}">${mediaVisual(item)}${item.kind !== 'image' ? `<span class="media-badge">${esc(item.kind)}</span>` : ''}</button>`;
  return `<article class="inline-media-shell media-${esc(item.kind)}${disposition ? ` media-${disposition}` : ''}" id="media-${domId(item.id)}" style="--media-aspect:${aspect}">${preview}${metadata}${mediaFileActions(item, 'inline-media-actions')}</article>`;
}

async function loadOverview(force = false) {
  const data = !state.overview || force ? await api('/api/overview') : state.overview;
  state.overview = data;
  state.capabilities = data.capabilities || {};
  state.serviceBuild = data.build || null;
  state.sync = data.sync;
  const currentService = data.capabilities?.favourites === true && data.capabilities?.hiddenMedia === true;
  const buildLabel = $('#buildLabel');
  buildLabel.textContent = currentService ? `Build ${data.build}` : `Restart needed · service ${data.build || 'unknown'}`;
  buildLabel.classList.toggle('warning', !currentService);
  buildLabel.title = currentService ? `UI ${APP_BUILD} · Service ${data.build}` : `UI ${APP_BUILD} is newer than the running service`;
  if (!currentService && !state.updateNoticeShown) {
    state.updateNoticeShown = true;
    requestAnimationFrame(() => toast(`Archiv has been updated to ${APP_BUILD.replace('-local', '')}. Restart the local service to finish loading the update.`));
  }
  updateSyncUi();
  return data;
}

function archiveHealth(data) {
  const missing = Number(data.totals?.unavailableMedia || 0);
  if (!data.verified) return { missing, tone: 'warning', label: 'Check required', heading: 'Archive needs attention', copy: 'Run an update before relying on this archive as your latest saved copy.' };
  if (missing) return { missing, tone: 'warning', label: 'Archive checked', heading: 'Archive stored locally', copy: `${plural(missing, 'historical file reference')} could not be matched to a recoverable local file.` };
  return { missing, tone: 'success', label: 'Archive checked', heading: 'Archive stored locally', copy: 'The archive structure and every indexed file passed the latest check.' };
}

async function renderHome() {
  const data = await loadOverview();
  const totals = data.totals;
  const health = archiveHealth(data);
  state.mediaContext = data.recentMedia;
  const topStats = $('#topStats');
  topStats.innerHTML = `<button class="top-stat-link" type="button" data-stat-view="conversations"><strong>${fmtNumber(totals.conversations)}</strong> conversations</button><button class="top-stat-link" type="button" data-stat-view="messages"><strong>${fmtNumber(totals.messages)}</strong> messages</button><button class="top-stat-link" type="button" data-stat-view="media" data-stat-kind="image"><strong>${fmtNumber(totals.image)}</strong> images</button><button class="top-stat-link" type="button" data-stat-view="media" data-stat-kind="video"><strong>${fmtNumber(totals.video)}</strong> videos</button><button class="top-stat-link" type="button" data-stat-view="media" data-stat-kind="audio"><strong>${fmtNumber(totals.audio)}</strong> audio</button><button class="top-stat-link" type="button" data-stat-view="media" data-stat-kind="file"><strong>${fmtNumber(totals.file)}</strong> files</button>`;
  topStats.hidden = false;
  main.innerHTML = `<div class="content-grid home-content">
      <section><div class="section-head"><h2>Recent conversations</h2><button class="text-button" data-go="conversations">View all</button></div><div class="panel">${data.recentConversations.map(conversationRow).join('') || '<div class="empty-state">No conversations yet.</div>'}</div></section>
      <aside><div class="section-head"><h2>Latest media</h2><button class="text-button" data-go="media">Open gallery</button></div><div class="panel media-rail">${data.recentMedia.slice(0, 8).map(mediaCard).join('') || '<div class="empty-state">No local media yet.</div>'}</div>
      <div class="section-head"><h2>Archive status</h2><button class="text-button" data-go="archive">View status</button></div><div class="panel health-card"><span class="status-pill ${health.tone === 'warning' ? 'warning' : ''}">${uiIcon(health.tone === 'warning' ? 'alert' : 'check')}${health.label}</span><h3>${plural(totals.media, 'file')} available</h3><p>${health.copy}</p><div class="health-list"><div class="health-item"><span>Last archive check</span><strong>${fmtRelative(data.verifiedAt)}</strong></div></div></div></aside>
    </div>`;
}

async function renderConversations() {
  const filter = state.conversationFilter;
  const data = await api(`/api/conversations?q=${encodeURIComponent(filter.q)}&kind=${encodeURIComponent(filter.kind)}&sort=${encodeURIComponent(filter.sort)}&limit=200`);
  main.innerHTML = `<section class="conversation-workspace"><aside class="conversation-rail"><div class="conversation-toolbar"><span class="result-count" id="conversationCount">${plural(data.total, 'conversation')}</span><input class="toolbar-search" id="conversationSearch" type="search" aria-label="Filter conversations" placeholder="Filter conversations…" value="${esc(filter.q)}"><select id="conversationSort" aria-label="Sort conversations"><option value="recent">Most recent</option><option value="oldest">Oldest</option><option value="title">Title</option><option value="messages">Most messages</option></select><div class="chips" aria-label="Conversation type">${['all', 'chat', 'agentic', 'studio', 'recovered'].map((kind) => `<button class="chip ${filter.kind === kind ? 'active' : ''}" data-conversation-kind="${kind}" aria-pressed="${filter.kind === kind}">${kind[0].toUpperCase() + kind.slice(1)}</button>`).join('')}</div></div><div class="conversation-list" id="conversationList">${data.items.map(conversationRow).join('') || '<div class="empty-state"><h3>No conversations match</h3><p>Try a broader filter.</p></div>'}</div></aside><article class="reader" id="reader"><div class="reader-empty"><div><strong>Select a conversation</strong><p>Its complete transcript and files will open here.</p></div></div></article></section>`;
  $('#conversationSort').value = filter.sort;
  if (state.conversation) await openConversation(state.conversation.id, state.conversation.hit, state.conversation.mediaId);
}

async function refreshConversationList() {
  const filter = state.conversationFilter;
  const data = await api(`/api/conversations?q=${encodeURIComponent(filter.q)}&kind=${encodeURIComponent(filter.kind)}&sort=${encodeURIComponent(filter.sort)}&limit=200`);
  $('#conversationCount').textContent = plural(data.total, 'conversation');
  $('#conversationList').innerHTML = data.items.map(conversationRow).join('') || '<div class="empty-state"><h3>No conversations match</h3><p>Try a broader filter.</p></div>';
}

function inlineMarkdown(value, query = '') {
  let safe = query ? highlight(value, query) : esc(value);
  safe = safe.replace(/`([^`]+)`/g, '<code>$1</code>');
  safe = safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  safe = safe.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  safe = safe.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  return safe;
}

function formatMessage(value, query = '') {
  const lines = String(value || '').split(/\r?\n/);
  const output = [];
  let paragraph = [];
  let list = null;
  let code = null;
  const flushParagraph = () => { if (paragraph.length) output.push(`<p>${paragraph.map((line) => inlineMarkdown(line, query)).join('<br>')}</p>`); paragraph = []; };
  const closeList = () => { if (list) { output.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    const fence = /^```([^\s]*)/.exec(line);
    if (fence) {
      if (code !== null) { output.push(`<pre><code data-language="${esc(code.language)}">${esc(code.lines.join('\n'))}</code></pre>`); code = null; }
      else { flushParagraph(); closeList(); code = { language: fence[1], lines: [] }; }
      continue;
    }
    if (code) { code.lines.push(line); continue; }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flushParagraph(); closeList(); output.push('<hr>'); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { flushParagraph(); closeList(); const level = heading[1].length + 2; output.push(`<h${level}>${inlineMarkdown(heading[2], query)}</h${level}>`); continue; }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) { flushParagraph(); const type = bullet ? 'ul' : 'ol'; if (list !== type) { closeList(); output.push(`<${type}>`); list = type; } output.push(`<li>${inlineMarkdown((bullet || numbered)[1], query)}</li>`); continue; }
    const quote = /^>\s?(.+)$/.exec(line);
    if (quote) { flushParagraph(); closeList(); output.push(`<blockquote>${inlineMarkdown(quote[1], query)}</blockquote>`); continue; }
    paragraph.push(line);
  }
  if (code) output.push(`<pre><code data-language="${esc(code.language)}">${esc(code.lines.join('\n'))}</code></pre>`);
  flushParagraph(); closeList();
  return output.join('');
}

function renderMediaGroup(items, label = '') {
  if (!items.length) return '';
  return `<section class="conversation-media-group">${label ? `<h3>${esc(label)}</h3>` : ''}<div class="inline-media-grid">${items.map(inlineMediaCard).join('')}</div></section>`;
}

function renderTurnMedia(items) {
  const input = items.filter((item) => item.mediaDisposition === 'input');
  const output = items.filter((item) => item.mediaDisposition === 'output');
  const other = items.filter((item) => !['input', 'output'].includes(item.mediaDisposition));
  return `${renderMediaGroup(input, 'Input')}${renderMediaGroup(output, 'Output')}${renderMediaGroup(other)}`;
}

function renderConversationMediaStrip(items) {
  if (!items.length) return '';
  return `<section class="conversation-media-strip"><div><strong>Media</strong><span>${plural(items.length, 'file')}</span></div><div class="media-strip-track">${items.map((item) => `<button data-scroll-media="${esc(item.id)}" aria-label="Jump to ${esc(item.fileName || item.kind)} in this conversation" title="${esc(item.fileName || item.kind)}">${mediaVisual(item)}</button>`).join('')}</div></section>`;
}

function messageMetrics(message) {
  const value = String(message.text || '');
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  const exactTokens = Number(message.outputTokens || message.totalTokens || 0);
  const tokens = exactTokens || (value ? Math.max(1, Math.ceil(value.length / 4)) : 0);
  const duration = fmtDuration(message.executionTimeMs);
  const status = typeof message.status === 'string' && /[a-z]/i.test(message.status) ? message.status.replaceAll('_', ' ') : null;
  return [
    message.model && !message.studioTurn ? { text: message.model } : null,
    tokens ? { text: `${exactTokens ? '' : '≈ '}${fmtNumber(tokens)} tokens`, title: exactTokens ? 'Token count saved by Venice' : 'Estimated from text length; Venice did not save a token count for this response' } : null,
    words ? { text: plural(words, 'word') } : null,
    duration ? { text: duration, title: 'Response time saved by Venice' } : null,
    status ? { text: status } : null
  ].filter(Boolean);
}

function renderMessage(message, hit, media) {
  const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'other';
  const author = role === 'user' ? 'You' : role === 'assistant' ? (message.model || 'Assistant') : (message.role || 'Message');
  const copyLabel = role === 'user' ? 'Copy prompt' : 'Copy response';
  const metadata = messageMetrics(message).map((entry) => `<span class="message-metric"${entry.title ? ` title="${esc(entry.title)}"` : ''}>${esc(entry.text)}</span>`).join('');
  const studioClass = message.studioTurn ? ` studio-turn${message.studioType ? ` studio-${esc(message.studioType)}` : ''}` : '';
  return `<section class="message ${role}${studioClass} ${message.id === hit ? 'hit' : ''}" id="message-${domId(message.id)}" data-message-id="${esc(message.id)}">
    <div class="message-head"><span class="message-role">${esc(author)}</span><span class="message-time" title="${esc(message.createdAt || '')}">${fmtDateTime(message.createdAt)}</span><button class="message-copy-top" data-copy-message="${esc(message.id)}" aria-label="${copyLabel}" title="${copyLabel}">${uiIcon('copy')}</button></div>
    <div class="message-text">${formatMessage(message.text, message.id === hit ? state.search.q : '')}</div>${renderTurnMedia(media)}
    <footer class="message-footer"><div class="message-metadata">${metadata}</div><button class="message-copy-bottom" data-copy-message="${esc(message.id)}">${uiIcon('copy')}<span>${copyLabel}</span></button></footer>
  </section>`;
}

function renderPromptNavigator(messages) {
  const prompts = messages.filter((message) => message.role === 'user');
  if (prompts.length < 2) return '';
  return `<nav class="prompt-navigator" aria-label="Jump between your prompts"><span class="prompt-track" aria-hidden="true"></span>${prompts.map((message, index) => `<button type="button" data-prompt-jump="${esc(message.id)}" aria-label="Jump to prompt ${index + 1} of ${prompts.length}" title="Prompt ${index + 1} of ${prompts.length}"><span></span></button>`).join('')}</nav>`;
}

function initializePromptNavigator(reader) {
  const buttons = $$('[data-prompt-jump]', reader);
  if (!buttons.length) return;
  let scheduled = false;
  const update = () => {
    scheduled = false;
    const headerHeight = $('.reader-header', reader)?.getBoundingClientRect().height || 0;
    const threshold = reader.getBoundingClientRect().top + headerHeight + 24;
    let active = 0;
    buttons.forEach((button, index) => {
      const message = document.getElementById(`message-${domId(button.dataset.promptJump)}`);
      if (message && message.getBoundingClientRect().top <= threshold) active = index;
    });
    if (reader.scrollHeight - reader.scrollTop - reader.clientHeight < 12) active = buttons.length - 1;
    buttons.forEach((button, index) => { button.classList.toggle('active', index === active); button.setAttribute('aria-current', index === active ? 'true' : 'false'); });
  };
  const onScroll = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(update); } };
  reader.addEventListener('scroll', onScroll, { passive: true });
  requestAnimationFrame(update);
}

function searchResultKey(item) {
  return `${item.type}:${item.id}:${item.conversationId || ''}`;
}

function searchResultButton(item, index, compact = false) {
  const selected = state.search.selected?.key === searchResultKey(item);
  return `<button class="search-result${compact ? ' compact' : ''}${selected ? ' selected' : ''}" data-search-result-index="${index}"${selected ? ' aria-current="true"' : ''}>
    <span class="type-pill">${esc(item.type)}${item.kind ? ` · ${esc(item.kind)}` : ''}${item.role ? ` · ${esc(item.role)}` : ''}</span>
    <div class="result-title">${highlight(item.title || 'Untitled', state.search.q)}</div>
    <div class="result-excerpt">${highlight(item.excerpt, state.search.q)}</div>
    <div class="row-meta">${fmtDate(item.date)}${item.model ? ` · ${esc(item.model)}` : ''}</div>
  </button>`;
}

function searchTranscriptResults() {
  return (state.search.data?.items || []).filter((item) => item.type !== 'media');
}

function searchReviewControls() {
  const results = searchTranscriptResults();
  const selectedIndex = results.findIndex((item) => searchResultKey(item) === state.search.selected?.key);
  if (selectedIndex < 0) return '';
  return `<div class="search-review-nav"><span>${selectedIndex + 1} of ${results.length}</span><button class="icon-text-button" data-search-step="-1" ${selectedIndex === 0 ? 'disabled' : ''} aria-label="Previous search result">${uiIcon('chevron-left')}</button><button class="icon-text-button" data-search-step="1" ${selectedIndex === results.length - 1 ? 'disabled' : ''} aria-label="Next search result">${uiIcon('chevron-right')}</button></div>`;
}

async function openConversation(id, hit = null, mediaId = null, context = 'library') {
  const item = await api(`/api/conversations/${encodeURIComponent(id)}`);
  if (context === 'library') state.conversation = { id, hit, mediaId };
  state.mediaContext = item.media;
  $$('.conversation-row').forEach((row) => {
    const selected = row.dataset.conversation === id;
    row.classList.toggle('selected', selected);
    if (selected) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  });
  const reader = $('#reader');
  if (!reader) return nav('conversations');
  const mediaByMessage = new Map();
  for (const media of item.media) {
    const displayMessageId = media.displayMessageId || media.messageId;
    if (!displayMessageId) continue;
    const messageKey = String(displayMessageId);
    if (!mediaByMessage.has(messageKey)) mediaByMessage.set(messageKey, []);
    mediaByMessage.get(messageKey).push(media);
  }
  const messageIds = new Set(item.messages.map((message) => String(message.id)));
  const unlinked = item.media.filter((media) => !(media.displayMessageId || media.messageId) || !messageIds.has(String(media.displayMessageId || media.messageId)));
  state.messageText = new Map(item.messages.map((message) => [String(message.id), String(message.text || '')]));
  const messages = item.messages.map((message) => renderMessage(message, hit, mediaByMessage.get(String(message.id)) || [])).join('');
  const returnAction = context === 'search' ? searchReviewControls() : state.returnToMedia ? `<button class="text-button return-context" data-go="media">${uiIcon('arrow-left')} Back to media</button>` : '';
  const backLabel = context === 'search' ? 'Results' : 'Conversations';
  reader.innerHTML = `<header class="reader-header"><button class="text-button reader-back" id="readerBack">${uiIcon('arrow-left')} ${backLabel}</button>${returnAction}<h2>${esc(item.title)}</h2><div class="reader-meta"><span>${fmtDate(item.updatedAt)}</span><span>${plural(item.messages.length, 'message')}</span><span>${plural(item.media.length, 'file')}</span></div></header>${renderConversationMediaStrip(item.media)}${renderPromptNavigator(item.messages)}<div class="transcript">${renderMediaGroup(unlinked, 'Media in this conversation')}${messages || '<div class="empty-state">No readable messages were found in this conversation.</div>'}</div>`;
  reader.classList.add('open');
  initializePromptNavigator(reader);
  $('#readerBack')?.addEventListener('click', () => {
    if (context === 'search') { state.search.selected = null; renderSearch(); }
    else reader.classList.remove('open');
  });
  const targetId = mediaId ? `media-${domId(mediaId)}` : hit ? `message-${domId(hit)}` : null;
  if (targetId) setTimeout(() => document.getElementById(targetId)?.scrollIntoView({ block: 'center' }), 80);
}

async function renderMedia() {
  const filter = state.mediaFilter;
  const data = await api(mediaRequestUrl(2000));
  state.mediaData = data;
  state.mediaContext = data.items;
  const visible = data.items.slice(0, state.mediaLimit);
  const emptyHeading = filter.favourites ? 'No starred media match' : 'No generated media matches';
  const emptyCopy = filter.favourites ? 'Star media in the gallery or viewer, or broaden these filters.' : 'Try another file type, broaden the search or show uploads.';
  const hiddenLabel = filter.showHidden ? 'Hide hidden items' : 'Show hidden items';
  const hiddenFilter = `<button class="hidden-filter${filter.showHidden ? ' active' : ''}" type="button" data-toggle-hidden aria-pressed="${filter.showHidden}" aria-label="${hiddenLabel}" title="${hiddenLabel}">${uiIcon(filter.showHidden ? 'eye' : 'eye-off')}</button>`;
  main.innerHTML = `<section class="media-workspace"><header class="media-page-toolbar"><div class="compact-view-head"><div><h1>Media</h1><span data-media-total>${plural(data.total, 'item')}</span></div><div class="media-view-controls"><span data-media-showing>Showing ${fmtNumber(visible.length)}</span><select id="mediaSort" aria-label="Sort media"><option value="recent">Newest first</option><option value="oldest">Oldest first</option><option value="session">Studio / conversation</option><option value="model">Model</option><option value="name">File name</option></select></div></div><div class="toolbar media-toolbar"><input class="toolbar-search media-search" id="mediaSearch" type="search" aria-label="Search media" placeholder="Search filenames, prompts and formats…" value="${esc(filter.q)}"><button class="favourites-filter${filter.favourites ? ' active' : ''}" type="button" data-toggle-favourites aria-pressed="${filter.favourites}">${starIcon()}<span>Starred</span><strong data-media-starred-count>${fmtNumber(data.favourites || 0)}</strong></button><div class="chips" aria-label="Media type">${['all', 'image', 'video', 'audio', 'file'].map((kind) => `<button class="chip ${filter.kind === kind ? 'active' : ''}" data-media-kind="${kind}" aria-pressed="${filter.kind === kind}">${kind === 'all' ? 'All' : kind[0].toUpperCase() + kind.slice(1)} <span data-media-facet="${kind}">${fmtNumber(data.facets[kind] || 0)}</span></button>`).join('')}</div><button class="uploads-toggle${filter.uploads ? ' active' : ''}" type="button" data-toggle-uploads aria-pressed="${filter.uploads}"><span class="toggle-track" aria-hidden="true"><span></span></span><span>Show uploads</span><strong data-media-upload-count>${fmtNumber(data.uploads || 0)}</strong></button>${hiddenFilter}</div></header><div class="gallery-scroll"><section class="gallery">${visible.map(mediaCard).join('') || `<div class="empty-state"><h3>${emptyHeading}</h3><p>${emptyCopy}</p></div>`}</section>${mediaLoadMoreMarkup(data.total, visible.length)}</div></section>`;
  $('#mediaSort').value = filter.sort;
}

function mediaRequestUrl(limit = 2000) {
  const filter = state.mediaFilter;
  const params = new URLSearchParams({
    q: filter.q,
    kind: filter.kind,
    status: 'available',
    source: filter.source,
    uploads: filter.uploads ? 'include' : 'exclude',
    favourites: filter.favourites ? 'only' : 'all',
    hidden: filter.showHidden ? 'include' : 'exclude',
    sort: filter.sort,
    limit: String(limit)
  });
  return `/api/media?${params}`;
}

function mediaLoadMoreMarkup(total, visible) {
  const remaining = Math.max(0, Number(total || 0) - Number(visible || 0));
  if (!remaining || visible >= state.mediaContext.length) return '';
  return `<div class="load-more"><button class="primary" data-load-more>Load ${fmtNumber(Math.min(MEDIA_PAGE_SIZE, remaining))} more</button><span>${fmtNumber(remaining)} remaining</span></div>`;
}

function visibleMediaCount() {
  return $$('.gallery > .media-card-shell').length;
}

function updateMediaToolbar(data = state.mediaData) {
  const workspace = $('.media-workspace');
  if (!workspace || !data) return;
  const visible = visibleMediaCount();
  $('[data-media-total]', workspace).textContent = plural(data.total, 'item');
  $('[data-media-showing]', workspace).textContent = `Showing ${fmtNumber(visible)}`;
  $('[data-media-starred-count]', workspace).textContent = fmtNumber(data.favourites || 0);
  $('[data-media-upload-count]', workspace).textContent = fmtNumber(data.uploads || 0);
  for (const kind of ['all', 'image', 'video', 'audio', 'file']) {
    const facet = $(`[data-media-facet="${kind}"]`, workspace);
    if (facet) facet.textContent = fmtNumber(data.facets?.[kind] || 0);
  }
}

function updateMediaLoadMore(data = state.mediaData) {
  const scroller = $('.gallery-scroll');
  if (!scroller || !data) return;
  const visible = visibleMediaCount();
  const markup = mediaLoadMoreMarkup(data.total, visible);
  const current = $('.load-more', scroller);
  if (!markup) current?.remove();
  else if (current) current.outerHTML = markup;
  else scroller.insertAdjacentHTML('beforeend', markup);
}

function loadMoreMedia() {
  const gallery = $('.gallery');
  const scroller = $('.gallery-scroll');
  if (!gallery || !scroller) return;
  const start = visibleMediaCount();
  const end = Math.min(start + MEDIA_PAGE_SIZE, state.mediaContext.length);
  const next = state.mediaContext.slice(start, end);
  if (!next.length) return updateMediaLoadMore();
  const scrollTop = scroller.scrollTop;
  gallery.insertAdjacentHTML('beforeend', next.map(mediaCard).join(''));
  state.mediaLimit = end;
  updateMediaToolbar();
  updateMediaLoadMore();
  requestAnimationFrame(() => { scroller.scrollTop = scrollTop; });
}

function removeUnstarredMedia(updated) {
  const gallery = $('.gallery');
  const scroller = $('.gallery-scroll');
  if (!gallery || !scroller) return;
  const scrollTop = scroller.scrollTop;
  const removed = state.mediaContext.filter((item) => sameMediaAsset(item, updated));
  const removedIds = new Set(removed.map((item) => String(item.id)));
  state.mediaContext = state.mediaContext.filter((item) => !sameMediaAsset(item, updated));
  $$('[data-media-card]', gallery).forEach((card) => { if (removedIds.has(String(card.dataset.mediaCard))) card.remove(); });
  if (!visibleMediaCount()) gallery.innerHTML = '<div class="empty-state"><h3>No starred media match</h3><p>Star media in the gallery or viewer, or broaden these filters.</p></div>';
  state.mediaLimit = visibleMediaCount();
  updateMediaToolbar();
  updateMediaLoadMore();
  requestAnimationFrame(() => { scroller.scrollTop = scrollTop; });
}

function removeHiddenMedia(updates) {
  const gallery = $('.gallery');
  const scroller = $('.gallery-scroll');
  if (!gallery || !scroller || !updates.length) return;
  const matches = (item) => updates.some((updated) => sameMediaAsset(item, updated));
  const scrollTop = scroller.scrollTop;
  const removedIds = new Set(state.mediaContext.filter(matches).map((item) => String(item.id)));
  state.mediaContext = state.mediaContext.filter((item) => !matches(item));
  $$('[data-media-card]', gallery).forEach((card) => { if (removedIds.has(String(card.dataset.mediaCard))) card.remove(); });
  if (!visibleMediaCount()) gallery.innerHTML = '<div class="empty-state"><h3>No visible media match</h3><p>Turn on Show hidden or broaden these filters.</p></div>';
  state.mediaLimit = visibleMediaCount();
  if (state.mediaData) state.mediaData.items = state.mediaContext;
  updateMediaToolbar();
  updateMediaLoadMore();
  requestAnimationFrame(() => { scroller.scrollTop = scrollTop; });
}

async function refreshMediaAfterFavourite(updated) {
  const summary = await api(mediaRequestUrl(1));
  state.mediaData = { ...summary, items: state.mediaContext };
  updateMediaToolbar();
  updateMediaLoadMore();
  if (state.mediaFilter.favourites && !updated.isFavourite) {
    if ($('#modalBackdrop').hidden) removeUnstarredMedia(updated);
    else state.mediaPendingRemoval = updated;
  }
}

async function probeDimensions(item) {
  if (item.width && item.height) return `${fmtNumber(item.width)} × ${fmtNumber(item.height)} px`;
  if (!item.available || !['image', 'video'].includes(item.kind)) return 'Dimensions unavailable';
  return new Promise((resolve) => {
    const node = item.kind === 'image' ? new Image() : document.createElement('video');
    const done = () => resolve(item.kind === 'image' ? `${fmtNumber(node.naturalWidth)} × ${fmtNumber(node.naturalHeight)} px` : `${fmtNumber(node.videoWidth)} × ${fmtNumber(node.videoHeight)} px`);
    node.onload = done;
    node.onloadedmetadata = done;
    node.onerror = () => resolve('Dimensions unavailable');
    node.src = item.fileUrl;
  });
}

function mediaStage(item) {
  if (!item.available) return '<div class="media-unavailable"><p>Venice kept a reference to this item, but the original file was no longer available.</p></div>';
  if (item.kind === 'image') return `<img src="${esc(item.fileUrl)}" data-zoomable draggable="false" alt="${esc(item.fileName || 'Archived image')}">`;
  if (item.kind === 'video') return `<video src="${esc(item.fileUrl)}" controls preload="metadata" playsinline></video>`;
  if (item.kind === 'audio') return `<audio src="${esc(item.fileUrl)}" controls preload="metadata"></audio>`;
  const previewType = attachmentPreviewType(item);
  if (['pdf', 'markdown', 'text'].includes(previewType)) return `<div class="attachment-preview" id="attachmentPreview"><div class="attachment-preview-loading"><div class="spinner"></div><p>Opening ${esc(item.fileName || 'attachment')}…</p></div></div>`;
  return `<div class="media-unavailable"><span class="file-glyph">${uiIcon('file')}</span><p>This file type does not have an in-app preview.</p><a class="primary" href="${esc(item.fileUrl)}" target="_blank" rel="noreferrer">Open file</a></div>`;
}

function zoomNavigator(item) {
  if (!item.available || item.kind !== 'image') return '';
  return `<aside class="zoom-navigator${state.mediaNavigatorCollapsed ? ' collapsed' : ''}" data-zoom-navigator aria-label="Image navigator" hidden>
    <div class="zoom-navigator-head"><strong>Navigator</strong><output data-zoom-level aria-live="polite">100%</output><button class="zoom-fit-button" type="button" data-zoom-fit>Fit</button><button class="zoom-navigator-collapse" type="button" data-zoom-minimise aria-expanded="${!state.mediaNavigatorCollapsed}" aria-label="${state.mediaNavigatorCollapsed ? 'Expand' : 'Minimise'} image navigator" title="${state.mediaNavigatorCollapsed ? 'Expand' : 'Minimise'} navigator">${uiIcon('chevron-down')}</button></div>
    <button class="zoom-map" type="button" data-zoom-map aria-label="Move around the zoomed image"><img src="${esc(item.fileUrl)}" alt=""><span class="zoom-viewport" aria-hidden="true"></span></button>
    <div class="zoom-controls" role="group" aria-label="Image zoom controls"><button type="button" data-zoom-step="-1" aria-label="Zoom out">−</button><button type="button" data-zoom-actual title="Show image at 100%">100%</button><button type="button" data-zoom-step="1" aria-label="Zoom in">+</button></div>
  </aside>`;
}

function initializeImageZoom() {
  const modal = $('#mediaModal');
  const stage = $('.media-stage', modal);
  const image = $('[data-zoomable]', modal);
  const navigator = $('[data-zoom-navigator]', modal);
  const map = $('[data-zoom-map]', modal);
  if (!stage || !image || !navigator || !map) return;
  const ready = () => {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const scale = Math.min(156 / image.naturalWidth, 106 / image.naturalHeight);
    map.style.width = `${Math.max(24, Math.round(image.naturalWidth * scale))}px`;
    map.style.height = `${Math.max(24, Math.round(image.naturalHeight * scale))}px`;
    updateZoomNavigator();
  };
  if (image.complete) ready();
  else image.addEventListener('load', ready, { once: true });
}

function imageZoomLayout(stage, image, percent = state.mediaZoomPercent) {
  const scale = Number(percent || 100) / 100;
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  return {
    width,
    height,
    offsetX: Math.max(0, (stage.clientWidth - width) / 2),
    offsetY: Math.max(0, (stage.clientHeight - height) / 2)
  };
}

function currentImageZoomFocus() {
  const modal = $('#mediaModal');
  const stage = $('.media-stage.zoomed', modal);
  const image = $('[data-zoomable]', modal);
  if (!stage || !image || !image.naturalWidth || !image.naturalHeight) return null;
  const layout = imageZoomLayout(stage, image);
  return {
    x: Math.max(0, Math.min(1, (stage.scrollLeft + stage.clientWidth / 2 - layout.offsetX) / layout.width)),
    y: Math.max(0, Math.min(1, (stage.scrollTop + stage.clientHeight / 2 - layout.offsetY) / layout.height))
  };
}

function imageZoomFocusAtPoint(stage, image, clientX, clientY) {
  if (!stage || !image?.naturalWidth || !image.naturalHeight) return { x: .5, y: .5 };
  const stageRect = stage.getBoundingClientRect();
  let width;
  let height;
  let left;
  let top;
  if (stage.classList.contains('zoomed')) {
    const layout = imageZoomLayout(stage, image);
    ({ width, height } = layout);
    left = layout.offsetX - stage.scrollLeft;
    top = layout.offsetY - stage.scrollTop;
  } else {
    const fitScale = Math.min(stage.clientWidth / image.naturalWidth, stage.clientHeight / image.naturalHeight);
    width = image.naturalWidth * fitScale;
    height = image.naturalHeight * fitScale;
    left = (stage.clientWidth - width) / 2;
    top = (stage.clientHeight - height) / 2;
  }
  const clamp = (value) => Math.max(0, Math.min(1, value));
  return {
    x: clamp((clientX - stageRect.left - left) / Math.max(1, width)),
    y: clamp((clientY - stageRect.top - top) / Math.max(1, height))
  };
}

function updateZoomControls() {
  const modal = $('#mediaModal');
  const level = $('[data-zoom-level]', modal);
  if (level) level.textContent = `${Number(state.mediaZoomPercent.toFixed(1))}%`;
  const lower = $('[data-zoom-step="-1"]', modal);
  const upper = $('[data-zoom-step="1"]', modal);
  if (lower) lower.disabled = state.mediaZoomPercent <= IMAGE_ZOOM_STEPS[0];
  if (upper) upper.disabled = state.mediaZoomPercent >= IMAGE_ZOOM_STEPS.at(-1);
}

function applyImageZoom(percent, focus = currentImageZoomFocus() || { x: .5, y: .5 }) {
  const modal = $('#mediaModal');
  const stage = $('.media-stage', modal);
  const image = $('[data-zoomable]', modal);
  const navigator = $('[data-zoom-navigator]', modal);
  if (!stage || !image || !navigator || !image.naturalWidth || !image.naturalHeight) return;
  state.mediaZoomPercent = Math.max(IMAGE_ZOOM_STEPS[0], Math.min(IMAGE_ZOOM_STEPS.at(-1), Number(percent || 100)));
  stage.classList.add('zoomed');
  const layout = imageZoomLayout(stage, image);
  image.style.width = `${layout.width}px`;
  image.style.height = `${layout.height}px`;
  image.style.margin = `${layout.offsetY}px ${layout.offsetX}px`;
  navigator.hidden = false;
  updateZoomControls();
  requestAnimationFrame(() => {
    stage.scrollLeft = layout.offsetX + focus.x * layout.width - stage.clientWidth / 2;
    stage.scrollTop = layout.offsetY + focus.y * layout.height - stage.clientHeight / 2;
    updateZoomNavigator();
  });
}

function setImageZoom(zoomed) {
  const modal = $('#mediaModal');
  const stage = $('.media-stage', modal);
  const image = $('[data-zoomable]', modal);
  const navigator = $('[data-zoom-navigator]', modal);
  if (!stage || !image || !navigator || !image.naturalWidth || !image.naturalHeight) return;
  if (!zoomed) {
    stage.classList.remove('zoomed', 'panning');
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
    image.style.removeProperty('width');
    image.style.removeProperty('height');
    image.style.removeProperty('margin');
    state.mediaZoomPercent = 100;
    updateZoomControls();
    navigator.hidden = true;
    return;
  }
  applyImageZoom(100, { x: .5, y: .5 });
}

function stepImageZoom(direction, focus = currentImageZoomFocus() || { x: .5, y: .5 }) {
  const current = state.mediaZoomPercent;
  const target = direction > 0
    ? IMAGE_ZOOM_STEPS.find((step) => step > current + .01)
    : [...IMAGE_ZOOM_STEPS].reverse().find((step) => step < current - .01);
  if (target != null) applyImageZoom(target, focus);
}

function toggleZoomNavigator() {
  const navigator = $('[data-zoom-navigator]', $('#mediaModal'));
  const toggle = $('[data-zoom-minimise]', navigator);
  if (!navigator || !toggle) return;
  state.mediaNavigatorCollapsed = !navigator.classList.contains('collapsed');
  navigator.classList.toggle('collapsed', state.mediaNavigatorCollapsed);
  toggle.setAttribute('aria-expanded', String(!state.mediaNavigatorCollapsed));
  toggle.setAttribute('aria-label', `${state.mediaNavigatorCollapsed ? 'Expand' : 'Minimise'} image navigator`);
  toggle.setAttribute('title', `${state.mediaNavigatorCollapsed ? 'Expand' : 'Minimise'} navigator`);
}

function updateZoomNavigator() {
  const modal = $('#mediaModal');
  const stage = $('.media-stage.zoomed', modal);
  const image = $('[data-zoomable]', modal);
  const viewport = $('.zoom-viewport', modal);
  if (!stage || !image || !viewport || !image.naturalWidth || !image.naturalHeight) return;
  const layout = imageZoomLayout(stage, image);
  const visibleWidth = Math.min(1, stage.clientWidth / layout.width);
  const visibleHeight = Math.min(1, stage.clientHeight / layout.height);
  const left = visibleWidth >= 1 ? 0 : Math.max(0, Math.min(1 - visibleWidth, (stage.scrollLeft - layout.offsetX) / layout.width));
  const top = visibleHeight >= 1 ? 0 : Math.max(0, Math.min(1 - visibleHeight, (stage.scrollTop - layout.offsetY) / layout.height));
  viewport.style.left = `${left * 100}%`;
  viewport.style.top = `${top * 100}%`;
  viewport.style.width = `${visibleWidth * 100}%`;
  viewport.style.height = `${visibleHeight * 100}%`;
  updateZoomControls();
}

function moveFromZoomNavigator(event, map = event.target.closest('[data-zoom-map]')) {
  const modal = $('#mediaModal');
  const stage = $('.media-stage.zoomed', modal);
  const image = $('[data-zoomable]', modal);
  if (!map || !stage || !image) return;
  const layout = imageZoomLayout(stage, image);
  const rect = map.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
  stage.scrollLeft = layout.offsetX + x * layout.width - stage.clientWidth / 2;
  stage.scrollTop = layout.offsetY + y * layout.height - stage.clientHeight / 2;
  updateZoomNavigator();
}

function attachmentPreviewType(item) {
  const name = String(item.fileName || item.title || '').toLowerCase();
  const mime = String(item.mimeType || '').toLowerCase().split(';')[0];
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  if (mime === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (mime === 'text/markdown' || ['.md', '.markdown', '.mdown'].includes(extension)) return 'markdown';
  if (mime.startsWith('text/') || ['.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.xml', '.log', '.js', '.mjs', '.css', '.html', '.htm'].includes(extension)) return 'text';
  return null;
}

async function loadAttachmentPreview(item) {
  const container = $('#attachmentPreview');
  if (!container) return;
  try {
    const previewType = attachmentPreviewType(item);
    let storedAsText = false;
    if (previewType === 'pdf') {
      const signatureResponse = await fetch(item.fileUrl, { headers: { range: 'bytes=0-1023' } });
      if (!signatureResponse.ok) throw new Error('The saved file could not be read.');
      const signature = new TextDecoder('latin1').decode(await signatureResponse.arrayBuffer());
      if (signature.includes('%PDF-')) {
        container.innerHTML = `<iframe class="attachment-preview-frame" src="${esc(item.fileUrl)}#view=FitH&toolbar=1" title="${esc(item.fileName || 'PDF attachment')}"></iframe>`;
        return;
      }
      storedAsText = true;
    }
    const response = await fetch(item.fileUrl, { headers: { range: 'bytes=0-1048575' } });
    if (!response.ok) throw new Error('The saved file could not be read.');
    let content = await response.text();
    const contentRange = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(response.headers.get('content-range') || '');
    const truncated = Boolean(contentRange && Number(contentRange[2]) + 1 < Number(contentRange[3]));
    const name = String(item.fileName || '').toLowerCase();
    if (previewType === 'text' && /\.(json|jsonl)$/.test(name)) {
      try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { /* Keep JSON Lines and partial documents readable as text. */ }
    }
    const body = previewType === 'markdown'
      ? `<div class="message-text">${formatMessage(content)}</div>`
      : storedAsText
        ? `<div class="extracted-text">${esc(content || 'This file is empty.')}</div>`
        : `<pre><code>${esc(content || 'This file is empty.')}</code></pre>`;
    const notes = [
      storedAsText ? 'Venice stored extracted text for this PDF, so the readable text is shown here.' : '',
      truncated ? 'Previewing the first 1 MB. Open the file to read the rest.' : ''
    ].filter(Boolean);
    container.innerHTML = `<article class="attachment-document">${body}</article>${notes.length ? `<p class="attachment-preview-note">${notes.join(' ')}</p>` : ''}`;
  } catch (error) {
    container.innerHTML = `<div class="attachment-preview-loading">${uiIcon('alert')}<p>${esc(error.message)}</p><a class="primary" href="${esc(item.fileUrl)}" target="_blank" rel="noreferrer">Open file</a></div>`;
  }
}

async function openMedia(id) {
  const wasClosed = $('#modalBackdrop').hidden;
  if (wasClosed) state.modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let contextIndex = state.mediaContext.findIndex((entry) => entry.id === id);
  let item = contextIndex >= 0 ? state.mediaContext[contextIndex] : null;
  if (!item || !Object.prototype.hasOwnProperty.call(item, 'fileUrl') || !Object.prototype.hasOwnProperty.call(item, 'mimeType')) {
    item = await api(`/api/media/${encodeURIComponent(id)}`);
    if (contextIndex >= 0) state.mediaContext[contextIndex] = item;
  }
  if (contextIndex < 0) { state.mediaContext = [item]; contextIndex = 0; }
  state.mediaItem = item;
  state.mediaIndex = contextIndex;
  const modal = $('#mediaModal');
  const hasPrevious = state.mediaIndex > 0;
  const hasNext = state.mediaIndex >= 0 && state.mediaIndex < state.mediaContext.length - 1;
  const canOpenContext = item.conversationId && item.conversationMessageCount > 0;
  const contextLabel = item.conversationKind === 'studio' ? 'Open Studio session' : 'Open conversation';
  const showModel = !item.isUploaded && ['image', 'video', 'audio'].includes(item.kind);
  const modelMarkup = showModel
    ? `<div><dt>Model</dt><dd${item.modelId && item.modelId !== item.model ? ` title="Model ID: ${esc(item.modelId)}"` : ''}>${esc(item.model || 'Not recorded')}</dd></div>`
    : '';
  const contextNote = !canOpenContext && item.recoveredFrom
    ? '<p class="media-context-note">This was recovered as a standalone file; its original conversation or Studio session was not included.</p>'
    : !canOpenContext && item.conversationId
      ? '<p class="media-context-note">Venice saved the file collection, but not a readable session timeline for this item.</p>'
      : '';
  state.mediaZoomPercent = 100;
  modal.className = `media-modal${state.mediaDetailsOpen ? '' : ' details-hidden'}`;
  modal.setAttribute('aria-labelledby', 'mediaDetailTitle');
  const starLabel = item.isFavourite ? 'Unstar this item' : 'Star this item';
  const hiddenLabel = item.isHidden ? 'Show in gallery' : 'Hide from gallery';
  const hiddenTitle = item.isHidden ? 'Return this item to the default gallery' : 'Hide this item from discovery views; the archived file remains unchanged';
  modal.innerHTML = `<div class="media-stage-shell"><div class="media-stage">${mediaStage(item)}</div>${zoomNavigator(item)}</div>
    <div class="viewer-chrome"><span class="viewer-count">${state.mediaIndex + 1} of ${state.mediaContext.length}</span><button class="viewer-favourite-toggle${item.isFavourite ? ' active' : ''}" data-favourite-media="${esc(item.id)}" type="button" aria-pressed="${Boolean(item.isFavourite)}" aria-label="${starLabel}" title="${starLabel}">${starIcon()}</button><button class="viewer-details-toggle${state.mediaDetailsOpen ? ' active' : ''}" data-toggle-details aria-label="${state.mediaDetailsOpen ? 'Hide' : 'Show'} information panel" aria-keyshortcuts="i" aria-pressed="${state.mediaDetailsOpen}" title="Toggle information panel (I)">${panelIcon()}</button><button class="viewer-close" data-close-modal aria-label="Close viewer">${closeIcon()}</button></div>
    <button class="viewer-arrow previous" data-media-step="-1" ${hasPrevious ? '' : 'disabled'} aria-label="Previous item">${uiIcon('chevron-left')}</button><button class="viewer-arrow next" data-media-step="1" ${hasNext ? '' : 'disabled'} aria-label="Next item">${uiIcon('chevron-right')}</button>
    <aside class="media-detail" aria-hidden="${!state.mediaDetailsOpen}"><div class="media-detail-head"><span class="type-pill">${esc(item.kind)} · ${item.available ? 'Saved locally' : 'Missing file'}<span data-media-visibility>${item.isHidden ? ' · Hidden from gallery' : ''}</span></span></div><h2 id="mediaDetailTitle">${esc(item.title || item.fileName || item.id)}</h2>${item.fileName && item.title && item.title !== item.fileName ? `<p class="detail-filename">${esc(item.fileName)}</p>` : ''}
      <dl class="detail-list"><div><dt>Created</dt><dd>${fmtDateTime(item.createdAt)}</dd></div>${modelMarkup}<div><dt>Dimensions</dt><dd id="mediaDimensions">${item.width && item.height ? `${fmtNumber(item.width)} × ${fmtNumber(item.height)} px` : ['image', 'video'].includes(item.kind) ? 'Checking…' : 'Not applicable'}</dd></div><div><dt>File</dt><dd>${esc(item.mimeType || 'Format unavailable')} · ${fmtBytes(item.bytes)}</dd></div></dl>
      ${item.prompt ? `<section class="prompt-detail"><div><h3>Prompt</h3><button class="text-button" data-copy-prompt>Copy</button></div><p>${esc(item.prompt)}</p></section>` : '<section class="prompt-detail"><h3>Prompt</h3><p class="muted">No prompt was stored with this item.</p></section>'}
      ${mediaFileActions(item, 'media-detail-actions')}
      <button class="media-hide-action${item.isHidden ? ' active' : ''}" type="button" data-hidden-media="${esc(item.id)}" aria-pressed="${Boolean(item.isHidden)}" title="${esc(hiddenTitle)}">${uiIcon(item.isHidden ? 'eye' : 'eye-off')}<span>${hiddenLabel}</span></button>
      ${canOpenContext ? `<button class="primary wide" data-show-conversation="${esc(item.conversationId)}" data-message-id="${esc(item.displayMessageId || item.messageId || '')}" data-linked-media="${esc(item.id)}">${contextLabel}</button>` : contextNote}
    </aside>`;
  $('#modalBackdrop').hidden = false;
  document.body.classList.add('modal-open');
  $('.viewer-close', modal)?.focus({ preventScroll: true });
  initializeImageZoom();
  if (['image', 'video'].includes(item.kind)) $('#mediaDimensions').textContent = await probeDimensions(item);
  loadAttachmentPreview(item);
  for (const neighbour of [state.mediaContext[state.mediaIndex - 1], state.mediaContext[state.mediaIndex + 1]]) if (neighbour?.available && neighbour.kind === 'image') new Image().src = neighbour.fileUrl;
}

async function stepMedia(offset) {
  const target = state.mediaContext[state.mediaIndex + Number(offset)];
  if (!target) return;
  stopMediaPlayback();
  await openMedia(target.id);
}

function stopMediaPlayback() {
  $$('#mediaModal video, #mediaModal audio').forEach((player) => {
    player.pause();
    player.removeAttribute('src');
    player.load();
  });
}

function closeMedia() {
  stopMediaPlayback();
  $('#modalBackdrop').hidden = true;
  document.body.classList.remove('modal-open');
  state.mediaItem = null;
  state.mediaZoomPercent = 100;
  state.mediaPan = null;
  state.navigatorPan = null;
  state.modalReturnFocus?.focus?.({ preventScroll: true });
  state.modalReturnFocus = null;
  if (state.mediaPendingRemoval && state.view === 'media') {
    const pending = state.mediaPendingRemoval;
    state.mediaPendingRemoval = null;
    removeUnstarredMedia(pending);
  }
  if (state.mediaPendingHiddenRemovals.length && state.view === 'media') {
    const pending = state.mediaPendingHiddenRemovals;
    state.mediaPendingHiddenRemovals = [];
    removeHiddenMedia(pending);
  }
  if (state.hiddenSurfaceNeedsRefresh) {
    state.hiddenSurfaceNeedsRefresh = false;
    if (state.view === 'home') renderHome().catch((error) => toast(error.message));
    if (state.view === 'search') renderSearch().catch((error) => toast(error.message));
  }
}

async function showMediaInfo(id, button) {
  $$('.media-info-popover').forEach((node) => node.remove());
  const item = state.mediaContext.find((entry) => entry.id === id) || await api(`/api/media/${encodeURIComponent(id)}`);
  const dimensions = await probeDimensions(item);
  const showModel = !item.isUploaded && ['image', 'video', 'audio'].includes(item.kind);
  const model = showModel ? (item.model || 'Not recorded') : null;
  const modelMarkup = model ? `<span class="media-info-model"${item.modelId && item.modelId !== item.model ? ` title="Model ID: ${esc(item.modelId)}"` : ''}><b>Model</b>${esc(model)}</span>` : '';
  const popover = document.createElement('aside');
  popover.className = 'media-info-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', 'Media information');
  popover.innerHTML = `<strong>${esc(item.title || item.fileName || item.kind)}</strong><span>${fmtDateTime(item.createdAt)}</span>${modelMarkup}<span>${esc(dimensions)} · ${fmtBytes(item.bytes)}</span>${item.prompt ? `<p>${esc(item.prompt)}</p>` : ''}<button class="text-button" data-media="${esc(item.id)}">Open details</button>`;
  document.body.append(popover);
  const anchor = button.getBoundingClientRect();
  const bounds = popover.getBoundingClientRect();
  popover.style.left = `${Math.max(12, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 12))}px`;
  popover.style.top = `${Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - bounds.height - 12))}px`;
}

function searchTerms(query) {
  const terms = [];
  for (const match of String(query || '').matchAll(/"([^"]+)"|(\S+)/g)) terms.push((match[1] || match[2] || '').trim());
  return [...new Set(terms.filter(Boolean))].sort((left, right) => right.length - left.length);
}

function highlight(text, query) {
  let safe = esc(text || '');
  for (const term of searchTerms(query)) {
    const literal = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = state.search.wholeWord
      ? new RegExp(`(^|[^\\p{L}\\p{N}])(${literal})(?=$|[^\\p{L}\\p{N}])`, 'giu')
      : new RegExp(`(${literal})`, 'gi');
    safe = safe.replace(pattern, state.search.wholeWord ? '$1<mark>$2</mark>' : '<mark>$1</mark>');
  }
  return safe;
}

function searchFilters(data) {
  return [['all', data.total], ['conversation', data.counts.conversation], ['message', data.counts.message], ['media', data.counts.media]].map(([type, count]) => `<button class="filter-option ${state.search.type === type ? 'active' : ''}" data-search-type="${type}" aria-pressed="${state.search.type === type}"><span>${type[0].toUpperCase() + type.slice(1)}</span><strong>${fmtNumber(count || 0)}</strong></button>`).join('');
}

function emptySearchWorkspace() {
  main.innerHTML = `<section class="search-review-workspace"><aside class="search-review-rail"><header><div><span class="eyebrow">Search</span><strong>Conversations, messages and files</strong></div></header><div class="search-review-list"><div class="empty-state"><h3>Start typing above</h3><p>Search a phrase, filename, model, person or idea.</p></div></div></aside><article class="reader search-review-reader" id="reader"><div class="reader-empty"><div><strong>Search your archive</strong><p>Results stay on the left while you review each conversation or attachment here.</p></div></div></article></section>`;
}

async function renderSearch() {
  const query = state.search.q.trim();
  $('#globalSearchInput').value = query;
  $('#wholeWordToggle').setAttribute('aria-pressed', String(state.search.wholeWord));
  updateRouteUrl('search');
  if (!query && !state.search.browseAll) {
    state.search.data = null;
    state.search.selected = null;
    emptySearchWorkspace();
    return;
  }
  const data = await api(`/api/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(state.search.type)}&match=${state.search.wholeWord ? 'whole' : 'contains'}&limit=300`);
  state.search.data = data;
  if (state.search.selected && !data.items.some((item) => searchResultKey(item) === state.search.selected.key)) state.search.selected = null;
  const selected = data.items.find((item) => searchResultKey(item) === state.search.selected?.key);
  const browseLabel = ({ all: 'archive items', conversation: 'conversations', message: 'messages', media: 'media' })[state.search.type];
  const subject = state.search.browseAll && !query ? `All ${browseLabel}` : `${plural(data.filteredTotal, 'match', 'matches')} for “${esc(query)}”`;
  const shown = data.items.length < data.filteredTotal ? ` · showing ${fmtNumber(data.items.length)}` : '';
  main.innerHTML = `<section class="search-review-workspace"><aside class="search-review-rail"><header><div><span class="eyebrow">Search results</span><strong>${subject}${shown}</strong></div><div class="search-type-filters" aria-label="Result type">${searchFilters(data)}</div></header><div class="search-review-list">${data.items.map((item, index) => searchResultButton(item, index, true)).join('') || '<div class="empty-state"><h3>No results</h3><p>Try fewer words, another content type, or turn off whole-word matching.</p></div>'}</div></aside><article class="reader search-review-reader" id="reader"><div class="reader-empty">${selected ? '<div class="spinner"></div><p>Opening result…</p>' : '<div><strong>Select a result</strong><p>The full conversation or attachment will open here.</p></div>'}</div></article></section>`;
  if (!selected) return;
  if (selected.type === 'media') return;
  await openConversation(selected.conversationId || selected.id, selected.type === 'message' ? selected.id : null, null, 'search');
  requestAnimationFrame(() => $('.search-result.selected')?.scrollIntoView({ block: 'nearest' }));
}

async function activateSearchResult(index) {
  const item = state.search.data?.items?.[Number(index)];
  if (!item) return;
  if (item.type === 'media') {
    state.search.selected = { key: searchResultKey(item) };
    $$('.search-result').forEach((result) => {
      const active = Number(result.dataset.searchResultIndex) === Number(index);
      result.classList.toggle('selected', active);
      if (active) result.setAttribute('aria-current', 'true'); else result.removeAttribute('aria-current');
    });
    state.mediaOrigin = 'search';
    state.mediaContext = state.search.data.items.filter((result) => result.type === 'media');
    return openMedia(item.id);
  }
  state.search.selected = { key: searchResultKey(item) };
  await renderSearch();
}

async function stepSearchResult(offset) {
  const results = searchTranscriptResults();
  const current = results.findIndex((item) => searchResultKey(item) === state.search.selected?.key);
  const target = results[current + Number(offset)];
  if (!target) return;
  const index = state.search.data.items.findIndex((item) => searchResultKey(item) === searchResultKey(target));
  await activateSearchResult(index);
}

async function renderArchive() {
  const data = await loadOverview();
  const totals = data.totals;
  const health = archiveHealth(data);
  const sourceLabel = [data.source?.browser, data.source?.profile].filter(Boolean).join(' · ') || 'Configured browser profile';
  main.innerHTML = `<div class="compact-view-head"><div><h1>Archive status</h1><span>${data.verified ? `Checked ${fmtRelative(data.verifiedAt)}` : 'Check required'}</span></div></div>
    <div class="archive-health-grid"><section class="panel health-hero ${health.tone}"><div class="check">${uiIcon(health.tone === 'warning' ? 'alert' : 'check')}</div><h2>${health.heading}</h2><p>${health.copy}</p><div class="overview-strip"><div class="overview-stat"><strong>${fmtNumber(totals.conversations)}</strong><span>Conversations</span></div><div class="overview-stat"><strong>${fmtNumber(totals.messages)}</strong><span>Messages</span></div><div class="overview-stat"><strong>${fmtNumber(totals.media)}</strong><span>Files available</span></div><div class="overview-stat"><strong>${fmtNumber(totals.unavailableMedia)}</strong><span>Historical references unavailable</span></div></div></section>
    <aside class="panel health-card"><span class="eyebrow">Archive location</span><h3>Your chosen folder</h3><div class="archive-path-row"><div class="path-box">${esc(data.archivePath)}</div><button class="secondary-button" id="openArchiveLocation">Open folder</button></div><div class="health-list"><div class="health-item"><span>Content source</span><strong>${esc(sourceLabel)}</strong></div><div class="health-item"><span>Last archive check</span><strong>${fmtRelative(data.verifiedAt)}</strong></div><div class="health-item"><span>Library access</span><strong>Served on this device only</strong></div></div><details class="advanced-details"><summary>Technical details</summary><div class="health-list"><div class="health-item"><span>Capture</span><strong>${esc(data.captureId || 'None')}</strong></div><div class="health-item"><span>Profile folder</span><strong>${esc(data.source?.profileDirectory || 'Unavailable')}</strong></div><div class="health-item"><span>Build</span><strong>${esc(data.build)}</strong></div></div></details><button class="primary wide" id="healthSync" aria-haspopup="dialog">Sync archive</button></aside></div>`;
}

async function render() {
  $('#topStats').hidden = state.view !== 'home';
  main.className = state.view === 'search' ? 'search-review-mode' : ['conversations', 'media'].includes(state.view) ? 'view-workspace' : state.view === 'archive' ? 'view-archive' : '';
  main.innerHTML = '<div class="page-loading" role="status"><div class="spinner"></div><p>Opening your library…</p></div>';
  try {
    if (state.view === 'home') await renderHome();
    if (state.view === 'conversations') await renderConversations();
    if (state.view === 'media') await renderMedia();
    if (state.view === 'search') await renderSearch();
    if (state.view === 'archive') await renderArchive();
  } catch (error) {
    console.error(error);
    main.innerHTML = `<div class="empty-state error-state">${uiIcon('alert')}<h3>This section couldn’t load</h3><p>The saved archive was not changed. Try loading this section again.</p><button class="primary" data-retry>Try again</button></div>`;
  }
}

function openNavigation() {
  $('#sidebar').classList.add('open');
  $('#navScrim').hidden = false;
  $('#menuBtn').setAttribute('aria-expanded', 'true');
  document.body.classList.add('nav-open');
  $('.nav-item.active', $('#sidebar'))?.focus({ preventScroll: true });
}

function closeNavigation() {
  $('#sidebar').classList.remove('open');
  $('#navScrim').hidden = true;
  $('#menuBtn').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('nav-open');
}

function openSync() {
  const drawer = $('#syncDrawer');
  const wasOpen = drawer.classList.contains('open');
  if (!wasOpen) state.drawerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  drawer.classList.add('open');
  drawer.removeAttribute('inert');
  drawer.setAttribute('aria-hidden', 'false');
  $('#drawerScrim').hidden = false;
  $('#syncButton').setAttribute('aria-expanded', 'true');
  document.body.classList.add('drawer-open');
  if (!wasOpen) $('#closeSync').focus({ preventScroll: true });
  pollSync();
}

function closeSync() {
  const drawer = $('#syncDrawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  drawer.setAttribute('inert', '');
  $('#drawerScrim').hidden = true;
  $('#syncButton').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('drawer-open');
  state.drawerReturnFocus?.focus?.({ preventScroll: true });
  state.drawerReturnFocus = null;
}

function syncResultMarkup(job) {
  const delta = job.result?.delta;
  const after = job.result?.after;
  if (!delta || !after) return '';
  const counts = [['image', delta.image], ['video', delta.video], ['audio file', delta.audio], ['other file', delta.file], ['conversation', delta.conversations], ['message', delta.messages]].filter(([, count]) => count > 0);
  if (!counts.length) return `<strong>You’re up to date</strong><p>We checked ${plural(after.conversations, 'conversation')} and ${plural(after.media, 'file')}. Nothing new was found.</p><small>Archive check completed · ${fmtDateTime(job.completedAt)}</small>`;
  return `<strong>New content saved</strong><ul>${counts.map(([label, count]) => `<li><span>${label}${count === 1 ? '' : 's'}</span><b>${fmtNumber(count)}</b></li>`).join('')}</ul><small>Archive check completed · ${fmtDateTime(job.completedAt)}</small>${delta.media ? '<button class="text-button" data-sync-view="media">View new media</button>' : ''}`;
}

function updateSyncUi() {
  const readyMessage = 'Ready. Select Fetch new content below to check Venice and save anything new.';
  const job = state.sync || { status: 'idle', message: readyMessage };
  const running = job.status === 'running';
  const complete = job.status === 'complete';
  $('#syncDrawer').classList.toggle('running', running);
  $('#syncDrawer').classList.toggle('complete', complete);
  $('#syncDrawer').classList.toggle('error', job.status === 'error');
  $('#syncButton').classList.toggle('running', running);
  $('#syncButton').classList.toggle('complete', complete);
  $('#syncButton').classList.toggle('error', job.status === 'error');
  $('#syncButton .sync-icon use')?.setAttribute('href', `#icon-${complete ? 'check' : job.status === 'error' ? 'alert' : 'refresh'}`);
  $('#syncMessage').textContent = job.status === 'idle' ? readyMessage : job.message;
  $('#syncTitle').textContent = complete ? 'Archive synced' : job.status === 'error' ? 'Sync needs attention' : running ? 'Syncing archive' : 'Sync archive';
  $('#syncStatusLabel').textContent = complete ? 'Complete' : job.status[0].toUpperCase() + job.status.slice(1);
  $('#startSync').disabled = running;
  $('#startSync').textContent = running ? 'Fetching…' : complete ? 'Check again' : job.status === 'error' ? 'Try again' : 'Fetch new content';
  $('#syncStateIcon').innerHTML = uiIcon(complete ? 'check' : job.status === 'error' ? 'alert' : 'refresh');
  const newItems = Number(job.result?.delta?.media || 0) + Number(job.result?.delta?.conversations || 0);
  const launcherLabel = running ? 'Fetching…' : complete ? (newItems ? `${newItems} new` : 'Up to date') : job.status === 'error' ? 'Review sync' : 'Sync archive';
  const launcherAriaLabel = running ? 'Archive sync in progress' : complete ? (newItems ? `Open archive sync: ${newItems} new items` : 'Open archive sync: up to date') : job.status === 'error' ? 'Open archive sync: attention needed' : 'Open archive sync panel';
  $('#syncButtonLabel').textContent = launcherLabel;
  $('#syncButton').setAttribute('aria-label', launcherAriaLabel);
  $('#syncButton').title = launcherAriaLabel;
  const result = $('#syncResult');
  result.innerHTML = complete ? syncResultMarkup(job) : '';
  result.hidden = !complete;
  const phases = [['prepare', `Connecting to ${state.overview?.source?.browser || 'browser'}`], ['snapshot', 'Reading Venice content'], ['discover', 'Finding new items'], ['media', 'Saving media'], ['library', 'Updating your library'], ['verify', 'Checking the archive'], ['complete', 'Complete']];
  const active = Math.max(0, phases.findIndex(([phase]) => phase === job.phase));
  $('#phaseTrack').innerHTML = phases.map(([phase, label], index) => `<span class="phase-dot ${index < active ? 'done' : index === active ? 'active' : ''}" title="${label}"></span>`).join('');
  const progress = complete || job.status === 'error' ? 100 : Math.max(4, (active / (phases.length - 1)) * 100);
  $('#syncProgress').style.width = `${progress}%`;
  $('.progress-bar').setAttribute('aria-valuenow', String(Math.round(progress)));
  $('#syncElapsed').textContent = job.startedAt ? `${Math.max(0, Math.round((new Date(job.completedAt || Date.now()) - new Date(job.startedAt)) / 1000))}s elapsed` : '';
  $('#syncLog').innerHTML = (job.log || []).map((item) => `<div>${esc(item.message)}</div>`).join('');
  const recentCompletion = complete && job.completedAt && Date.now() - new Date(job.completedAt).getTime() < 30000;
  if (recentCompletion && state.lastNotifiedSync !== job.completedAt) {
    state.lastNotifiedSync = job.completedAt;
    toast(job.message);
  }
}

async function pollSync() {
  clearTimeout(state.syncTimer);
  try {
    const previous = state.sync?.status;
    state.sync = await api('/api/sync/status');
    updateSyncUi();
    if (state.sync.status === 'running') state.syncTimer = setTimeout(pollSync, 900);
    if (previous === 'running' && state.sync.status === 'complete') {
      state.overview = null;
      await loadOverview(true);
      if (state.view === 'home') await renderHome();
      if (state.view === 'archive') await renderArchive();
    }
  } catch (error) {
    console.error(error);
  }
}

async function startSync() {
  openSync();
  try {
    state.sync = await api('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    updateSyncUi();
    pollSync();
  } catch (error) {
    toast(error.message);
  }
}

function toast(message) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  $('#toasts').append(node);
  setTimeout(() => node.remove(), 6000);
}

function sameMediaAsset(left, right) {
  if (!left || !right) return false;
  if (String(left.id) === String(right.id)) return true;
  return Boolean(left.sha256 && right.sha256 && String(left.sha256).toLowerCase() === String(right.sha256).toLowerCase());
}

function updateFavouriteState(updated) {
  const updateList = (items) => (items || []).map((item) => sameMediaAsset(item, updated) ? { ...item, isFavourite: updated.isFavourite } : item);
  state.mediaContext = updateList(state.mediaContext);
  if (state.overview?.recentMedia) state.overview.recentMedia = updateList(state.overview.recentMedia);
  if (sameMediaAsset(state.mediaItem, updated)) state.mediaItem = { ...state.mediaItem, isFavourite: updated.isFavourite };
  $$('[data-favourite-media]').forEach((button) => {
    const candidate = state.mediaContext.find((item) => String(item.id) === String(button.dataset.favouriteMedia)) || state.mediaItem;
    if (!sameMediaAsset(candidate, updated)) return;
    button.classList.toggle('active', updated.isFavourite);
    button.setAttribute('aria-pressed', String(updated.isFavourite));
    button.setAttribute('aria-label', updated.isFavourite ? 'Unstar this item' : 'Star this item');
    button.setAttribute('title', updated.isFavourite ? 'Unstar this item' : 'Star this item');
  });
}

async function toggleFavourite(id) {
  if (!requireCapability('favourites', 'starred media')) return;
  let current = sameMediaAsset(state.mediaItem, { id }) ? state.mediaItem : state.mediaContext.find((item) => String(item.id) === String(id));
  if (!current || !Object.prototype.hasOwnProperty.call(current, 'isFavourite')) current = await api(`/api/media/${encodeURIComponent(id)}`);
  const result = await api('/api/favourites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, favourite: !current.isFavourite }) });
  updateFavouriteState(result.item);
  toast(result.item.isFavourite ? 'Added to Starred' : 'Removed from Starred');
  if (state.view === 'media') await refreshMediaAfterFavourite(result.item);
}

function updateHiddenState(updated) {
  const updateList = (items) => (items || []).map((item) => sameMediaAsset(item, updated) ? { ...item, isHidden: updated.isHidden } : item);
  state.mediaContext = updateList(state.mediaContext);
  if (sameMediaAsset(state.mediaItem, updated)) state.mediaItem = { ...state.mediaItem, isHidden: updated.isHidden };
  $$('[data-media-card]').forEach((card) => {
    const candidate = state.mediaContext.find((item) => String(item.id) === String(card.dataset.mediaCard));
    if (!sameMediaAsset(candidate, updated)) return;
    card.classList.toggle('is-hidden', updated.isHidden);
    const visual = $('.media-card', card);
    const badge = $('.hidden-media-badge', card);
    if (updated.isHidden && visual && !badge) visual.insertAdjacentHTML('beforeend', '<span class="hidden-media-badge">Hidden</span>');
    if (!updated.isHidden) badge?.remove();
  });
  const button = $('[data-hidden-media]', $('#mediaModal'));
  if (button && sameMediaAsset(state.mediaItem, updated)) {
    const label = updated.isHidden ? 'Show in gallery' : 'Hide from gallery';
    const title = updated.isHidden ? 'Return this item to the default gallery' : 'Hide this item from discovery views; the archived file remains unchanged';
    button.classList.toggle('active', updated.isHidden);
    button.setAttribute('aria-pressed', String(updated.isHidden));
    button.setAttribute('title', title);
    button.innerHTML = `${uiIcon(updated.isHidden ? 'eye' : 'eye-off')}<span>${label}</span>`;
    const visibility = $('[data-media-visibility]', $('#mediaModal'));
    if (visibility) visibility.textContent = updated.isHidden ? ' · Hidden from gallery' : '';
  }
  state.overview = null;
  state.search.data = null;
}

function queueHiddenRemoval(updated) {
  state.mediaPendingHiddenRemovals = state.mediaPendingHiddenRemovals.filter((item) => !sameMediaAsset(item, updated));
  if (updated.isHidden) state.mediaPendingHiddenRemovals.push(updated);
}

async function refreshMediaAfterHidden(updated) {
  const summary = await api(mediaRequestUrl(1));
  state.mediaData = { ...summary, items: state.mediaContext };
  updateMediaToolbar();
  updateMediaLoadMore();
  if (!state.mediaFilter.showHidden) queueHiddenRemoval(updated);
}

async function toggleHidden(id) {
  if (!requireCapability('hiddenMedia', 'hidden media')) return;
  let current = sameMediaAsset(state.mediaItem, { id }) ? state.mediaItem : state.mediaContext.find((item) => String(item.id) === String(id));
  if (!current || !Object.prototype.hasOwnProperty.call(current, 'isHidden')) current = await api(`/api/media/${encodeURIComponent(id)}`);
  const result = await api('/api/hidden', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, hidden: !current.isHidden }) });
  updateHiddenState(result.item);
  toast(result.item.isHidden ? 'Hidden from gallery' : 'Returned to gallery');
  if (state.view === 'media') await refreshMediaAfterHidden(result.item);
  if (['home', 'search'].includes(state.view)) state.hiddenSurfaceNeedsRefresh = true;
}

async function copyText(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
    toast(successMessage);
  } catch {
    toast('Copy failed. Select the text and copy it manually.');
  }
}

function trapFocus(container, event) {
  if (event.key !== 'Tab') return false;
  const focusable = $$('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', container).filter((node) => node.offsetParent !== null);
  if (!focusable.length) return false;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); return true; }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); return true; }
  return false;
}

function toggleMediaDetails() {
  const zoomFocus = currentImageZoomFocus();
  state.mediaDetailsOpen = !state.mediaDetailsOpen;
  $('#mediaModal').classList.toggle('details-hidden', !state.mediaDetailsOpen);
  const toggle = $('[data-toggle-details]', $('#mediaModal'));
  toggle?.classList.toggle('active', state.mediaDetailsOpen);
  toggle?.setAttribute('aria-pressed', String(state.mediaDetailsOpen));
  toggle?.setAttribute('aria-label', `${state.mediaDetailsOpen ? 'Hide' : 'Show'} information panel`);
  $('.media-detail', $('#mediaModal'))?.setAttribute('aria-hidden', String(!state.mediaDetailsOpen));
  setTimeout(() => zoomFocus ? applyImageZoom(state.mediaZoomPercent, zoomFocus) : updateZoomNavigator(), 220);
}

document.addEventListener('click', (event) => {
  const favourite = event.target.closest('[data-favourite-media]');
  if (favourite) return toggleFavourite(favourite.dataset.favouriteMedia).catch((error) => toast(error.message));
  const hiddenMedia = event.target.closest('[data-hidden-media]');
  if (hiddenMedia) return toggleHidden(hiddenMedia.dataset.hiddenMedia).catch((error) => toast(error.message));
  const info = event.target.closest('[data-media-info]');
  if (info) return showMediaInfo(info.dataset.mediaInfo, info);
  if (!event.target.closest('.media-info-popover')) $$('.media-info-popover').forEach((node) => node.remove());
  const statLink = event.target.closest('[data-stat-view]');
  if (statLink) {
    const destination = statLink.dataset.statView;
    if (destination === 'media') {
      state.mediaFilter = { ...state.mediaFilter, q: '', kind: statLink.dataset.statKind || 'all', favourites: false, showHidden: false, sort: 'recent' };
      state.mediaLimit = MEDIA_PAGE_SIZE;
      return nav('media');
    }
    if (destination === 'messages') {
      state.search = { ...state.search, q: '', type: 'message', data: null, selected: null, browseAll: true };
      $('#globalSearchInput').value = '';
      return nav('search');
    }
    state.conversationFilter = { q: '', kind: 'all', sort: 'recent' };
    return nav('conversations');
  }
  const navButton = event.target.closest('[data-nav],[data-go]');
  if (navButton) {
    if (navButton.dataset.nav === 'conversations') state.returnToMedia = false;
    return nav(navButton.dataset.nav || navButton.dataset.go);
  }
  const conversation = event.target.closest('[data-conversation]');
  if (conversation) return openConversation(conversation.dataset.conversation);
  const scrollMedia = event.target.closest('[data-scroll-media]');
  if (scrollMedia) {
    const target = document.getElementById(`media-${domId(scrollMedia.dataset.scrollMedia)}`);
    if (!target) return;
    target.classList.add('jump-highlight');
    target.querySelector('.inline-media-card, .inline-audio-player')?.focus({ preventScroll: true });
    requestAnimationFrame(() => target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
    setTimeout(() => target.classList.remove('jump-highlight'), 1400);
    return;
  }
  const revealMedia = event.target.closest('[data-reveal-media]');
  if (revealMedia) return api('/api/reveal-file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: revealMedia.dataset.revealMedia }) }).then(() => toast('File shown in its folder')).catch((error) => toast(error.message));
  const media = event.target.closest('[data-media]');
  if (media) { $$('.inline-audio-player audio').forEach((player) => player.pause()); state.mediaOrigin = state.view; $$('.media-info-popover').forEach((node) => node.remove()); return openMedia(media.dataset.media); }
  if (event.target.closest('[data-zoom-minimise]')) { toggleZoomNavigator(); return; }
  const zoomStep = event.target.closest('[data-zoom-step]');
  if (zoomStep) { stepImageZoom(Number(zoomStep.dataset.zoomStep)); return; }
  if (event.target.closest('[data-zoom-actual]')) { applyImageZoom(100); return; }
  if (event.target.closest('[data-zoom-fit]')) { setImageZoom(false); return; }
  if (event.target.closest('[data-zoom-map]')) return;
  if (state.mediaDragged && event.target.closest('.media-stage')) {
    state.mediaDragged = false;
    event.preventDefault();
    return;
  }
  const zoomable = event.target.closest('[data-zoomable]');
  if (zoomable) {
    return;
  }
  const close = event.target.closest('[data-close-modal]');
  if (close) { closeMedia(); return; }
  const step = event.target.closest('[data-media-step]');
  if (step) return stepMedia(step.dataset.mediaStep);
  if (event.target.closest('[data-toggle-details]')) return toggleMediaDetails();
  if (event.target.closest('[data-copy-prompt]')) return copyText(state.mediaItem?.prompt || '', 'Prompt copied');
  const showConversation = event.target.closest('[data-show-conversation]');
  if (showConversation) {
    closeMedia();
    if (state.mediaOrigin === 'search') return renderSearch();
    state.returnToMedia = true;
    state.conversation = { id: showConversation.dataset.showConversation, hit: showConversation.dataset.messageId || null, mediaId: showConversation.dataset.linkedMedia || null };
    return nav('conversations');
  }
  const result = event.target.closest('[data-search-result-index]');
  if (result) return activateSearchResult(result.dataset.searchResultIndex);
  const searchStep = event.target.closest('[data-search-step]');
  if (searchStep) return stepSearchResult(searchStep.dataset.searchStep);
  if (event.target.closest('[data-search-all]')) { state.search.selected = null; return renderSearch(); }
  const conversationKind = event.target.closest('[data-conversation-kind]');
  if (conversationKind) { state.conversationFilter.kind = conversationKind.dataset.conversationKind; $$('.conversation-toolbar .chip').forEach((button) => { const active = button === conversationKind; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }); return refreshConversationList(); }
  const mediaKind = event.target.closest('[data-media-kind]');
  if (mediaKind) { state.mediaFilter.kind = mediaKind.dataset.mediaKind; state.mediaLimit = MEDIA_PAGE_SIZE; return renderMedia(); }
  if (event.target.closest('[data-toggle-favourites]')) { if (!requireCapability('favourites', 'the Starred filter')) return; state.mediaFilter.favourites = !state.mediaFilter.favourites; state.mediaLimit = MEDIA_PAGE_SIZE; return renderMedia(); }
  if (event.target.closest('[data-toggle-hidden]')) { if (!requireCapability('hiddenMedia', 'hidden media')) return; state.mediaFilter.showHidden = !state.mediaFilter.showHidden; state.mediaLimit = MEDIA_PAGE_SIZE; return renderMedia(); }
  if (event.target.closest('[data-toggle-uploads]')) { state.mediaFilter.uploads = !state.mediaFilter.uploads; state.mediaLimit = MEDIA_PAGE_SIZE; return renderMedia(); }
  if (event.target.closest('[data-load-more]')) return loadMoreMedia();
  const searchType = event.target.closest('[data-search-type]');
  if (searchType) { state.search.type = searchType.dataset.searchType; state.search.selected = null; updateRouteUrl('search'); return renderSearch(); }
  const copy = event.target.closest('[data-copy-message]');
  if (copy) return copyText(state.messageText.get(String(copy.dataset.copyMessage)) || '', copy.closest('.message')?.classList.contains('user') ? 'Prompt copied' : 'Response copied');
  const promptJump = event.target.closest('[data-prompt-jump]');
  if (promptJump) {
    const target = document.getElementById(`message-${domId(promptJump.dataset.promptJump)}`);
    if (!target) return;
    target.classList.add('jump-highlight');
    const reader = target.closest('.reader');
    const headerHeight = reader ? ($('.reader-header', reader)?.getBoundingClientRect().height || 0) : 0;
    const desiredViewportTop = (reader?.getBoundingClientRect().top || 0) + headerHeight + 12;
    const distance = Math.abs(target.getBoundingClientRect().top - desiredViewportTop);
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches || distance > (reader?.clientHeight || innerHeight) * 2 ? 'auto' : 'smooth';
    if (reader) {
      const targetTop = reader.scrollTop + target.getBoundingClientRect().top - reader.getBoundingClientRect().top - headerHeight - 12;
      reader.scrollTo({ top: Math.max(0, targetTop), behavior });
    } else target.scrollIntoView({ block: 'start', behavior });
    setTimeout(() => target.classList.remove('jump-highlight'), 1200);
    return;
  }
  if (event.target.closest('#syncButton,#healthSync')) return openSync();
  if (event.target.closest('#openArchiveLocation')) return api('/api/open-location', { method: 'POST' }).then(() => toast('Archive folder opened')).catch((error) => toast(error.message));
  if (event.target.closest('[data-sync-view]')) { closeSync(); return nav('media'); }
  if (event.target.closest('[data-retry]')) return render();
});

document.addEventListener('play', (event) => {
  if (!(event.target instanceof HTMLAudioElement) || !event.target.closest('.inline-audio-player')) return;
  $$('.inline-audio-player audio').forEach((player) => {
    if (player !== event.target) player.pause();
  });
}, true);

document.addEventListener('scroll', (event) => {
  $$('.media-info-popover').forEach((node) => node.remove());
  if (event.target instanceof Element && event.target.matches('.media-stage.zoomed')) updateZoomNavigator();
}, true);
window.addEventListener('resize', () => {
  $$('.media-info-popover').forEach((node) => node.remove());
  const focus = currentImageZoomFocus();
  if (focus) requestAnimationFrame(() => applyImageZoom(state.mediaZoomPercent, focus));
  else updateZoomNavigator();
});

document.addEventListener('dblclick', (event) => {
  if ($('#modalBackdrop').hidden) return;
  const stage = event.target.closest('.media-stage');
  const image = event.target.closest('[data-zoomable]') || (stage?.classList.contains('zoomed') ? $('[data-zoomable]', stage) : null);
  if (!stage || !image) return;
  const imageRect = image.getBoundingClientRect();
  if (event.clientX < imageRect.left || event.clientX > imageRect.right || event.clientY < imageRect.top || event.clientY > imageRect.bottom) return;
  event.preventDefault();
  const focus = imageZoomFocusAtPoint(stage, image, event.clientX, event.clientY);
  if (!stage.classList.contains('zoomed')) applyImageZoom(100, focus);
  else stepImageZoom(event.shiftKey || event.getModifierState?.('Shift') ? -1 : 1, focus);
});

$('#globalSearchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  state.search.q = $('#globalSearchInput').value.trim();
  if (state.view !== 'search') state.search.type = 'all';
  state.search.browseAll = false;
  state.search.selected = null;
  nav('search');
});
$('#wholeWordToggle').addEventListener('click', () => {
  state.search.wholeWord = !state.search.wholeWord;
  state.search.selected = null;
  $('#wholeWordToggle').setAttribute('aria-pressed', String(state.search.wholeWord));
  if (state.view === 'search') renderSearch();
});
$('#closeSync').addEventListener('click', closeSync);
$('#drawerScrim').addEventListener('click', closeSync);
$('#startSync').addEventListener('click', startSync);
$('#menuBtn').addEventListener('click', () => $('#sidebar').classList.contains('open') ? closeNavigation() : openNavigation());
$('#navScrim').addEventListener('click', closeNavigation);
$('#modalBackdrop').addEventListener('click', (event) => { if (event.target === $('#modalBackdrop')) closeMedia(); });
document.addEventListener('input', (event) => {
  if (event.target.id === 'globalSearchInput' && state.view === 'search') {
    state.search.q = event.target.value.trim();
    state.search.browseAll = false;
    state.search.selected = null;
    clearTimeout(event.target._timer);
    event.target._timer = setTimeout(renderSearch, 180);
  }
  if (event.target.id === 'conversationSearch') { state.conversationFilter.q = event.target.value; clearTimeout(event.target._timer); event.target._timer = setTimeout(refreshConversationList, 180); }
  if (event.target.id === 'mediaSearch') { state.mediaFilter.q = event.target.value; state.mediaLimit = MEDIA_PAGE_SIZE; clearTimeout(event.target._timer); event.target._timer = setTimeout(renderMedia, 180); }
});
document.addEventListener('change', (event) => {
  if (event.target.id === 'conversationSort') { state.conversationFilter.sort = event.target.value; refreshConversationList(); }
  if (event.target.id === 'mediaSort') { state.mediaFilter.sort = event.target.value; state.mediaLimit = MEDIA_PAGE_SIZE; renderMedia(); }
});

document.addEventListener('pointerdown', (event) => {
  const map = event.target.closest('[data-zoom-map]');
  if (map) {
    event.preventDefault();
    state.navigatorPan = { map, pointerId: event.pointerId };
    map.setPointerCapture?.(event.pointerId);
    moveFromZoomNavigator(event, map);
    return;
  }
  const stage = event.target.closest('.media-stage.zoomed');
  if (!stage || event.button !== 0) return;
  state.mediaDragged = false;
  state.mediaPan = { stage, pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop, dragging: false };
});
document.addEventListener('pointermove', (event) => {
  if (state.navigatorPan) {
    moveFromZoomNavigator(event, state.navigatorPan.map);
    return;
  }
  if (!state.mediaPan) return;
  const dx = event.clientX - state.mediaPan.x;
  const dy = event.clientY - state.mediaPan.y;
  if (!state.mediaPan.dragging) {
    if (Math.abs(dx) + Math.abs(dy) <= 5) return;
    state.mediaPan.dragging = true;
    state.mediaDragged = true;
    state.mediaPan.stage.setPointerCapture?.(state.mediaPan.pointerId);
    state.mediaPan.stage.classList.add('panning');
  }
  state.mediaPan.stage.scrollLeft = state.mediaPan.left - dx;
  state.mediaPan.stage.scrollTop = state.mediaPan.top - dy;
  updateZoomNavigator();
});

function finishMediaPan() {
  state.navigatorPan?.map.releasePointerCapture?.(state.navigatorPan.pointerId);
  state.navigatorPan = null;
  state.mediaPan?.stage.classList.remove('panning');
  if (state.mediaPan?.dragging) state.mediaPan.stage.releasePointerCapture?.(state.mediaPan.pointerId);
  state.mediaPan = null;
}

document.addEventListener('pointerup', finishMediaPan);
document.addEventListener('pointercancel', finishMediaPan);
document.addEventListener('keydown', (event) => {
  if (!$('#modalBackdrop').hidden && trapFocus($('#mediaModal'), event)) return;
  if ($('#syncDrawer').classList.contains('open') && trapFocus($('#syncDrawer'), event)) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (state.view !== 'search') nav('search');
    requestAnimationFrame(() => $('#globalSearchInput').focus());
  }
  if (!$('#modalBackdrop').hidden && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'i' && !event.target.closest('input, textarea, select, [contenteditable="true"]')) {
    event.preventDefault();
    toggleMediaDetails();
  }
  if (!$('#modalBackdrop').hidden && $('.media-stage.zoomed', $('#mediaModal')) && ['+', '='].includes(event.key)) { event.preventDefault(); stepImageZoom(1); }
  if (!$('#modalBackdrop').hidden && $('.media-stage.zoomed', $('#mediaModal')) && event.key === '-') { event.preventDefault(); stepImageZoom(-1); }
  if (!$('#modalBackdrop').hidden && event.key === 'ArrowLeft') { event.preventDefault(); stepMedia(-1); }
  if (!$('#modalBackdrop').hidden && event.key === 'ArrowRight') { event.preventDefault(); stepMedia(1); }
  if (event.key === 'Escape') {
    if (!$('#modalBackdrop').hidden) {
      event.preventDefault();
      if ($('.media-stage.zoomed', $('#mediaModal'))) setImageZoom(false);
      else closeMedia();
    }
    else if ($('#syncDrawer').classList.contains('open')) closeSync();
    else if ($('#sidebar').classList.contains('open')) closeNavigation();
    else if (state.view === 'search' && state.search.selected) { state.search.selected = null; renderSearch(); }
  }
});

const initial = location.hash.slice(1);
if (['home', 'conversations', 'media', 'search', 'archive'].includes(initial)) state.view = initial;
const initialParams = new URLSearchParams(location.search);
const initialQuery = initialParams.get('q')?.trim() || '';
const initialSearchType = initialParams.get('type') || 'all';
state.search.wholeWord = initialParams.get('whole') === '1';
state.search.browseAll = initialParams.get('browse') === 'all';
if (state.view === 'search' && initialQuery) {
  state.search.q = initialQuery;
  $('#globalSearchInput').value = initialQuery;
}
if (state.view === 'search' && ['all', 'conversation', 'message', 'media'].includes(initialSearchType)) state.search.type = initialSearchType;
updateRouteChrome(state.view);
window.addEventListener('hashchange', () => {
  const requested = location.hash.slice(1);
  if (!['home', 'conversations', 'media', 'search', 'archive'].includes(requested) || requested === state.view) return;
  if (requested !== 'search') {
    state.search = { ...state.search, q: '', type: 'all', data: null, selected: null, browseAll: false };
    $('#globalSearchInput').value = '';
  }
  state.view = requested;
  updateRouteUrl(requested);
  updateRouteChrome(requested);
  state.renderQueue = state.renderQueue.catch(() => {}).then(render);
});
state.renderQueue = loadOverview().then(render);
pollSync();
