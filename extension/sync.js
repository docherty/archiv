// Venice History Sync - Smart Merge Interface
// Compares backup file with live Venice data and allows selective sync

let backupData = null;
let websiteData = null;
let comparison = null;
let selectedItems = new Set();
const RESTORE_ENABLED = false;
const RESTORE_DISABLED_MESSAGE = 'Restore is intentionally disabled in this build until dry-run, rollback, and validation safeguards are complete.';

// DOM Elements
const elements = {
  fileSelectView: document.getElementById('fileSelectView'),
  loadingView: document.getElementById('loadingView'),
  comparisonView: document.getElementById('comparisonView'),
  dropZone: document.getElementById('dropZone'),
  fileInput: document.getElementById('fileInput'),
  messageBanner: document.getElementById('messageBanner'),
  backupStats: document.getElementById('backupStats'),
  backupDate: document.getElementById('backupDate'),
  websiteStats: document.getElementById('websiteStats'),
  restoreCount: document.getElementById('restoreCount'),
  syncedCount: document.getElementById('syncedCount'),
  backupNewCount: document.getElementById('backupNewCount'),
  conflictCount: document.getElementById('conflictCount'),
  conversationList: document.getElementById('conversationList'),
  selectAllRestore: document.getElementById('selectAllRestore'),
  deselectAll: document.getElementById('deselectAll'),
  cancelBtn: document.getElementById('cancelBtn'),
  applyBtn: document.getElementById('applyBtn'),
  previewModal: document.getElementById('previewModal'),
  modalTitle: document.getElementById('modalTitle'),
  modalBody: document.getElementById('modalBody'),
  modalClose: document.getElementById('modalClose')
};

// ===========================================
// Initialization
// ===========================================

function init() {
  if (!RESTORE_ENABLED) {
    elements.dropZone.classList.add('disabled');
    elements.fileInput.disabled = true;
    elements.selectAllRestore.disabled = true;
    elements.deselectAll.disabled = true;
    elements.applyBtn.disabled = true;
    elements.applyBtn.textContent = 'Restore Disabled';
    elements.cancelBtn.textContent = 'Close';
    elements.dropZone.addEventListener('click', () => showMessage('info', RESTORE_DISABLED_MESSAGE));
    elements.cancelBtn.addEventListener('click', () => window.close());
    showMessage('info', RESTORE_DISABLED_MESSAGE);
    return;
  }

  // File input handlers
  elements.dropZone.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', handleFileSelect);
  
  // Drag and drop
  elements.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.dropZone.style.borderColor = '#4ecdc4';
  });
  elements.dropZone.addEventListener('dragleave', () => {
    elements.dropZone.style.borderColor = '';
  });
  elements.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.dropZone.style.borderColor = '';
    if (e.dataTransfer.files.length) {
      handleFile(e.dataTransfer.files[0]);
    }
  });
  
  // Button handlers
  elements.selectAllRestore.addEventListener('click', selectAllRestorable);
  elements.deselectAll.addEventListener('click', deselectAll);
  elements.cancelBtn.addEventListener('click', () => window.close());
  elements.applyBtn.addEventListener('click', applyChanges);
  elements.modalClose.addEventListener('click', closeModal);
  elements.previewModal.addEventListener('click', (e) => {
    if (e.target === elements.previewModal) closeModal();
  });
}

// ===========================================
// File Handling
// ===========================================

function handleFileSelect(e) {
  if (e.target.files.length) {
    handleFile(e.target.files[0]);
  }
}

async function handleFile(file) {
  if (!RESTORE_ENABLED) {
    showMessage('info', RESTORE_DISABLED_MESSAGE);
    return;
  }

  if (!file.name.endsWith('.json')) {
    showMessage('error', 'Please select a JSON backup file');
    return;
  }
  
  showView('loading');
  
  try {
    // Read backup file
    const text = await file.text();
    backupData = JSON.parse(text);
    
    if (!backupData.version || !backupData.data) {
      throw new Error('Invalid backup file format');
    }
    
    // Get website data
    websiteData = await getWebsiteData();
    
    if (!websiteData || !websiteData.success) {
      throw new Error(websiteData?.error || 'Failed to get Venice data. Make sure Venice.ai is open.');
    }
    
    // Compare the data
    comparison = compareData(backupData, websiteData);
    
    // Update UI
    renderComparison();
    showView('comparison');
    
  } catch (err) {
    showMessage('error', 'Error: ' + err.message);
    showView('fileSelect');
  }
}

// ===========================================
// Data Fetching
// ===========================================

async function getWebsiteData() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ url: '*://venice.ai/*' }, async (tabs) => {
      if (tabs.length === 0) {
        reject(new Error('No Venice.ai tab found. Please open Venice.ai first.'));
        return;
      }
      
      try {
        const response = await chrome.tabs.sendMessage(tabs[0].id, {
          type: 'GET_FULL_DATA',
          encrypted: false
        });
        resolve(response);
      } catch (err) {
        reject(new Error('Failed to communicate with Venice. Try refreshing the Venice page.'));
      }
    });
  });
}

// ===========================================
// Data Comparison
// ===========================================

function compareData(backup, website) {
  const result = {
    conversations: [],
    summary: {
      restore: 0,    // Only in backup
      synced: 0,     // Same in both
      backupNew: 0,  // Only on website
      conflict: 0    // Different content
    }
  };
  
  const backupConvs = backup.data.conversations || [];
  const websiteConvs = website.data?.conversations || [];
  const backupMsgs = backup.data.messages || [];
  const websiteMsgs = website.data?.messages || [];
  
  // Create lookup maps
  const websiteConvMap = new Map(websiteConvs.map(c => [c.id, c]));
  const backupConvMap = new Map(backupConvs.map(c => [c.id, c]));
  const websiteMsgMap = new Map();
  const backupMsgMap = new Map();
  
  // Group messages by conversation
  websiteMsgs.forEach(m => {
    if (!websiteMsgMap.has(m.conversationId)) {
      websiteMsgMap.set(m.conversationId, []);
    }
    websiteMsgMap.get(m.conversationId).push(m);
  });
  
  backupMsgs.forEach(m => {
    if (!backupMsgMap.has(m.conversationId)) {
      backupMsgMap.set(m.conversationId, []);
    }
    backupMsgMap.get(m.conversationId).push(m);
  });
  
  // Check backup conversations against website
  for (const backupConv of backupConvs) {
    const websiteConv = websiteConvMap.get(backupConv.id);
    const backupMessages = backupMsgMap.get(backupConv.id) || [];
    const websiteMessages = websiteMsgMap.get(backupConv.id) || [];
    
    if (!websiteConv) {
      // Only in backup - can restore
      result.conversations.push({
        id: backupConv.id,
        status: 'restore',
        title: backupConv.title || 'Untitled',
        backupConv,
        backupMessages,
        websiteConv: null,
        websiteMessages: [],
        messageCount: backupMessages.length,
        date: formatDate(backupConv.createdAtUnixTimestamp)
      });
      result.summary.restore++;
    } else {
      // Exists in both - check if same
      const isSame = compareConversations(backupConv, websiteConv, backupMessages, websiteMessages);
      
      if (isSame) {
        result.conversations.push({
          id: backupConv.id,
          status: 'synced',
          title: backupConv.title || websiteConv.title || 'Untitled',
          backupConv,
          backupMessages,
          websiteConv,
          websiteMessages,
          messageCount: Math.max(backupMessages.length, websiteMessages.length),
          date: formatDate(backupConv.createdAtUnixTimestamp)
        });
        result.summary.synced++;
      } else {
        result.conversations.push({
          id: backupConv.id,
          status: 'conflict',
          title: backupConv.title || websiteConv.title || 'Untitled',
          backupConv,
          backupMessages,
          websiteConv,
          websiteMessages,
          messageCount: backupMessages.length,
          websiteMessageCount: websiteMessages.length,
          date: formatDate(backupConv.createdAtUnixTimestamp)
        });
        result.summary.conflict++;
      }
    }
  }
  
  // Check website conversations not in backup
  for (const websiteConv of websiteConvs) {
    if (!backupConvMap.has(websiteConv.id)) {
      const websiteMessages = websiteMsgMap.get(websiteConv.id) || [];
      result.conversations.push({
        id: websiteConv.id,
        status: 'backup-new',
        title: websiteConv.title || 'Untitled',
        backupConv: null,
        backupMessages: [],
        websiteConv,
        websiteMessages,
        messageCount: websiteMessages.length,
        date: formatDate(websiteConv.createdAtUnixTimestamp)
      });
      result.summary.backupNew++;
    }
  }
  
  // Sort by status priority: restore, conflict, backup-new, synced
  const statusOrder = { restore: 0, conflict: 1, 'backup-new': 2, synced: 3 };
  result.conversations.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);
  
  return result;
}

function compareConversations(backupConv, websiteConv, backupMsgs, websiteMsgs) {
  // Simple comparison: same number of messages
  if (backupMsgs.length !== websiteMsgs.length) {
    return false;
  }
  
  // Check if message IDs match
  const backupIds = new Set(backupMsgs.map(m => m.id));
  const websiteIds = new Set(websiteMsgs.map(m => m.id));
  
  if (backupIds.size !== websiteIds.size) return false;
  
  for (const id of backupIds) {
    if (!websiteIds.has(id)) return false;
  }
  
  return true;
}

function formatDate(timestamp) {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
  });
}

// ===========================================
// UI Rendering
// ===========================================

function renderComparison() {
  // Update stats
  elements.backupStats.textContent = `${backupData.stats?.conversations || 0} conversations, ${backupData.stats?.messages || 0} messages`;
  elements.backupDate.textContent = `Exported: ${new Date(backupData.exportedAt).toLocaleString()}`;
  elements.websiteStats.textContent = `${websiteData.stats?.conversationCount || 0} conversations, ${websiteData.stats?.messageCount || 0} messages`;
  
  // Update summary
  elements.restoreCount.textContent = comparison.summary.restore;
  elements.syncedCount.textContent = comparison.summary.synced;
  elements.backupNewCount.textContent = comparison.summary.backupNew;
  elements.conflictCount.textContent = comparison.summary.conflict;
  
  // Render conversation list
  renderConversationList();
}

function renderConversationList() {
  if (comparison.conversations.length === 0) {
    elements.conversationList.innerHTML = `
      <div class="empty-state">
        <div class="icon">📭</div>
        <p>No conversations to compare</p>
      </div>
    `;
    return;
  }
  
  elements.conversationList.innerHTML = comparison.conversations.map(conv => {
    const statusLabels = {
      restore: 'Only in backup',
      synced: 'Synced',
      'backup-new': 'Only on website',
      conflict: 'Conflict'
    };
    
    const statusIcons = {
      restore: '🟢',
      synced: '🟡',
      'backup-new': '🔵',
      conflict: '🟠'
    };
    
    const canSelect = conv.status === 'restore' || conv.status === 'conflict';
    const isSelected = selectedItems.has(conv.id);
    const safeId = escapeHtml(String(conv.id ?? ''));
    
    let actions = '';
    if (conv.status === 'restore') {
      actions = `
        <button class="btn-preview" data-preview="${safeId}">Preview</button>
        <button class="btn-restore" data-toggle="${safeId}">
          ${isSelected ? '✓ Selected' : '→ Select to Restore'}
        </button>
      `;
    } else if (conv.status === 'conflict') {
      actions = `
        <button class="btn-preview" data-preview="${safeId}">Compare</button>
        <button class="btn-restore" data-toggle="${safeId}">
          ${isSelected ? '✓ Selected' : '→ Restore from Backup'}
        </button>
      `;
    } else if (conv.status === 'backup-new') {
      actions = `
        <button class="btn-preview" data-preview="${safeId}">Preview</button>
        <span class="status-badge backup-new">Save to next backup</span>
      `;
    } else {
      actions = `<span class="status-badge synced">✓ Up to date</span>`;
    }
    
    let metaText = `${conv.messageCount} messages • ${conv.date}`;
    if (conv.status === 'conflict') {
      metaText = `Backup: ${conv.messageCount} msgs | Website: ${conv.websiteMessageCount} msgs • ${conv.date}`;
    }
    
    return `
      <div class="conversation-item ${conv.status} ${isSelected ? 'selected' : ''}" data-id="${safeId}">
        <div class="conversation-header">
          <div class="conversation-info">
            <div class="conversation-title">
              <span class="status-icon">${statusIcons[conv.status]}</span>
              ${escapeHtml(conv.title)}
            </div>
            <div class="conversation-meta">${statusLabels[conv.status]} • ${metaText}</div>
          </div>
          <div class="conversation-actions">
            ${actions}
          </div>
        </div>
      </div>
    `;
  }).join('');
  
  // Attach event listeners (CSP-compliant)
  attachConversationListeners();
  
  updateApplyButton();
}

function attachConversationListeners() {
  // Preview buttons
  document.querySelectorAll('[data-preview]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const convId = e.target.getAttribute('data-preview');
      previewConversation(convId);
    });
  });
  
  // Toggle selection buttons
  document.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const convId = e.target.getAttribute('data-toggle');
      toggleSelect(convId);
    });
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ===========================================
// Selection Management
// ===========================================

window.toggleSelect = function(convId) {
  if (selectedItems.has(convId)) {
    selectedItems.delete(convId);
  } else {
    selectedItems.add(convId);
  }
  renderConversationList();
};

function selectAllRestorable() {
  comparison.conversations.forEach(conv => {
    if (conv.status === 'restore' || conv.status === 'conflict') {
      selectedItems.add(conv.id);
    }
  });
  renderConversationList();
}

function deselectAll() {
  selectedItems.clear();
  renderConversationList();
}

function updateApplyButton() {
  elements.applyBtn.disabled = selectedItems.size === 0;
  elements.applyBtn.textContent = selectedItems.size > 0 
    ? `Apply ${selectedItems.size} Change${selectedItems.size > 1 ? 's' : ''}`
    : 'Apply Selected Changes';
}

// ===========================================
// Preview Modal
// ===========================================

window.previewConversation = function(convId) {
  const conv = comparison.conversations.find(c => c.id === convId);
  if (!conv) return;
  
  elements.modalTitle.textContent = conv.title;
  
  let content = '';
  
  if (conv.status === 'conflict') {
    // Show side-by-side comparison
    content = `
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
        <div>
          <h4 style="color: #4ecdc4; margin-bottom: 12px;">📁 Backup (${conv.backupMessages.length} messages)</h4>
          ${renderMessages(conv.backupMessages)}
        </div>
        <div>
          <h4 style="color: #9b59b6; margin-bottom: 12px;">🌐 Website (${conv.websiteMessages.length} messages)</h4>
          ${renderMessages(conv.websiteMessages)}
        </div>
      </div>
    `;
  } else {
    const messages = conv.backupMessages.length > 0 ? conv.backupMessages : conv.websiteMessages;
    content = renderMessages(messages);
  }
  
  elements.modalBody.innerHTML = content;
  elements.previewModal.classList.add('active');
};

function renderMessages(messages) {
  if (!messages || messages.length === 0) {
    return '<p style="color: #888;">No messages</p>';
  }
  
  return messages.slice(0, 20).map(msg => {
    // Venice message structure: role is in msg.role, content can be:
    // - msg.content (string) for simple messages
    // - msg.content (array) with objects like {type: 'text', text: '...'}
    // - msg.text for some formats
    const roleValue = String(msg.role || 'unknown').toLowerCase();
    const role = ['user', 'assistant', 'system', 'tool'].includes(roleValue) ? roleValue : 'unknown';
    let content = '';
    let imageHtml = '';
    
    // Handle content
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Venice uses array format: [{type: 'text', text: '...'}, {type: 'image_url', image_url: {...}}]
      for (const part of msg.content) {
        if (part.type === 'text' && part.text) {
          content += part.text;
        } else if (part.type === 'image_url' && part.image_url?.url) {
          imageHtml += `<img src="${escapeHtml(part.image_url.url)}" class="message-image" style="max-width: 200px; max-height: 150px; border-radius: 8px; margin: 8px 0;" />`;
        }
      }
    } else if (msg.text) {
      content = msg.text;
    }
    
    // Check for attachments (another Venice format)
    if (msg.attachments && Array.isArray(msg.attachments)) {
      for (const att of msg.attachments) {
        if (att.type === 'image' && att.url) {
          imageHtml += `<img src="${escapeHtml(att.url)}" class="message-image" style="max-width: 200px; max-height: 150px; border-radius: 8px; margin: 8px 0;" />`;
        }
      }
    }
    
    // Check for imageUrl directly on message
    if (msg.imageUrl) {
      imageHtml += `<img src="${escapeHtml(msg.imageUrl)}" class="message-image" style="max-width: 200px; max-height: 150px; border-radius: 8px; margin: 8px 0;" />`;
    }
    
    if (!content && !imageHtml) {
      content = '[No content]';
    }
    
    const truncatedContent = content.length > 500 ? content.substring(0, 500) + '...' : content;
    
    return `
      <div class="message-preview">
        <div class="role ${role}">${role}</div>
        ${imageHtml}
        <div class="content">${escapeHtml(truncatedContent)}</div>
      </div>
    `;
  }).join('') + (messages.length > 20 ? `<p style="color: #888; text-align: center;">... and ${messages.length - 20} more messages</p>` : '');
}

function closeModal() {
  elements.previewModal.classList.remove('active');
}

// ===========================================
// Apply Changes
// ===========================================

async function applyChanges() {
  if (!RESTORE_ENABLED) {
    showMessage('error', RESTORE_DISABLED_MESSAGE);
    return;
  }

  if (selectedItems.size === 0) return;
  
  elements.applyBtn.disabled = true;
  elements.applyBtn.textContent = 'Applying...';
  
  try {
    // Gather data to restore
    const conversationsToRestore = [];
    const messagesToRestore = [];
    const messageIdsToRestore = [];
    const imagesToRestore = [];
    
    // Build set of conversation IDs being restored
    const convIdsToRestore = new Set(selectedItems);
    
    for (const convId of selectedItems) {
      const conv = comparison.conversations.find(c => c.id === convId);
      if (conv && conv.backupConv) {
        conversationsToRestore.push(conv.backupConv);
        messagesToRestore.push(...conv.backupMessages);
      }
    }
    
    // Get message IDs for the messages we're restoring
    const messageIdSet = new Set(messagesToRestore.map(m => m.id));
    
    // Filter messageIds to only those for our conversations AND messages
    const allMessageIds = backupData.data.messageIds || [];
    for (const msgId of allMessageIds) {
      if (convIdsToRestore.has(msgId.conversationId) && messageIdSet.has(msgId.id)) {
        messageIdsToRestore.push(msgId);
      }
    }
    
    // Filter images to only those for our messages (check both 'images' and 'messageImages' keys)
    const allImages = backupData.data.images || backupData.data.messageImages || [];
    for (const img of allImages) {
      if (messageIdSet.has(img.messageId) || convIdsToRestore.has(img.conversationId)) {
        imagesToRestore.push(img);
      }
    }
    
    console.log('[Sync] Restoring:', {
      conversations: conversationsToRestore.length,
      messages: messagesToRestore.length,
      messageIds: messageIdsToRestore.length,
      images: imagesToRestore.length
    });
    
    const dataToRestore = {
      conversations: conversationsToRestore,
      messages: messagesToRestore,
      messageIds: messageIdsToRestore,
      messageImages: imagesToRestore
    };
    
    // Send to Venice
    await writeToVenice(dataToRestore);
    
    showMessage('success', `Successfully restored ${conversationsToRestore.length} conversation(s) with ${messagesToRestore.length} messages. Refresh Venice to see changes.`);
    
    // Reset selection
    selectedItems.clear();
    
    // Refresh comparison
    websiteData = await getWebsiteData();
    comparison = compareData(backupData, websiteData);
    renderComparison();
    
  } catch (err) {
    showMessage('error', 'Failed to apply changes: ' + err.message);
  } finally {
    elements.applyBtn.disabled = false;
    updateApplyButton();
  }
}

async function writeToVenice(data) {
  if (!RESTORE_ENABLED) {
    throw new Error(RESTORE_DISABLED_MESSAGE);
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.query({ url: '*://venice.ai/*' }, async (tabs) => {
      if (tabs.length === 0) {
        reject(new Error('No Venice.ai tab found'));
        return;
      }
      
      try {
        const response = await chrome.tabs.sendMessage(tabs[0].id, {
          type: 'WRITE_DATA',
          data
        });
        
        if (response?.success) {
          resolve(response);
        } else {
          reject(new Error(response?.error || 'Write failed'));
        }
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ===========================================
// UI Helpers
// ===========================================

function showView(view) {
  elements.fileSelectView.style.display = view === 'fileSelect' ? 'block' : 'none';
  elements.loadingView.style.display = view === 'loading' ? 'block' : 'none';
  elements.comparisonView.style.display = view === 'comparison' ? 'block' : 'none';
}

function showMessage(type, text) {
  elements.messageBanner.className = `message-banner ${type}`;
  elements.messageBanner.textContent = text;
  
  if (type !== 'error') {
    setTimeout(() => {
      elements.messageBanner.className = 'message-banner';
    }, 5000);
  }
}

// Initialize
init();
