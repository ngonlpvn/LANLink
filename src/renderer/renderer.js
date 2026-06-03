// --- UI State ---
const state = {
  me: null,
  interfaces: [],
  devices: [], // Discovered peers
  selectedPeerId: null,
  selectedFile: null,
  activeTab: 'files', // 'files' or 'text'
  activeTransfers: new Map(), // transferId -> progress object
  currentInvite: null, // holds details of currently visible incoming invite
  chatHistory: [], // array of messages: { id, sender: { id, alias }, receiverId, text, time }
  activeChartSessionId: null,
  speedChartInstance: null
};

// --- DOM Cache ---
const els = {
  localDeviceAlias: document.getElementById('localDeviceAlias'),
  localDeviceDetails: document.getElementById('localDeviceDetails'),
  localIpList: document.getElementById('localIpList'),
  interfaceCount: document.getElementById('interfaceCount'),
  peerConnectForm: document.getElementById('peerConnectForm'),
  peerIpInput: document.getElementById('peerIpInput'),
  peerConnectBtn: document.getElementById('peerConnectBtn'),
  rescanBtn: document.getElementById('rescanBtn'),
  deviceList: document.getElementById('deviceList'),
  radarContainer: document.getElementById('radarContainer'),
  radarStatusText: document.getElementById('radarStatusText'),
  tabFilesBtn: document.getElementById('tabFilesBtn'),
  tabTextBtn: document.getElementById('tabTextBtn'),
  tabFilesContent: document.getElementById('tabFilesContent'),
  tabTextContent: document.getElementById('tabTextContent'),
  fileDropzone: document.getElementById('fileDropzone'),
  pickFileBtn: document.getElementById('pickFileBtn'),
  selectedFileCard: document.getElementById('selectedFileCard'),
  selectedFileName: document.getElementById('selectedFileName'),
  selectedFileSize: document.getElementById('selectedFileSize'),
  clearFileBtn: document.getElementById('clearFileBtn'),
  
  // Chat DOMs
  textMessageForm: document.getElementById('textMessageForm'),
  textMessageInput: document.getElementById('textMessageInput'),
  sendMsgBtn: document.getElementById('sendMsgBtn'),
  chatMessages: document.getElementById('chatMessages'),

  selectedTargetBadge: document.getElementById('selectedTargetBadge'),
  transmitBtn: document.getElementById('transmitBtn'),
  activeTransmissionsBadge: document.getElementById('activeTransmissionsBadge'),
  transferList: document.getElementById('transferList'),
  eventLog: document.getElementById('eventLog'),
  clearLogBtn: document.getElementById('clearLogBtn'),
  
  // Invite Modal
  incomingInviteModal: document.getElementById('incomingInviteModal'),
  inviteSenderName: document.getElementById('inviteSenderName'),
  inviteFileList: document.getElementById('inviteFileList'),
  declineInviteBtn: document.getElementById('declineInviteBtn'),
  acceptInviteBtn: document.getElementById('acceptInviteBtn'),

  // Speed Chart Modal
  speedChartModal: document.getElementById('speedChartModal'),
  chartModalTitle: document.getElementById('chartModalTitle'),
  chartModalSubtitle: document.getElementById('chartModalSubtitle'),
  modalPauseBtn: document.getElementById('modalPauseBtn'),
  modalCancelBtn: document.getElementById('modalCancelBtn'),
  modalDeleteBtn: document.getElementById('modalDeleteBtn'),
  modalCloseBtn: document.getElementById('modalCloseBtn')
};

// --- Boot & Initialization ---
boot();

async function boot() {
  addLog('info', 'Booting LANLink UI engine...');
  
  try {
    // 1. Get local device info
    state.me = await window.lanlink.getInfo();
    els.localDeviceAlias.textContent = state.me.name;
    els.localDeviceDetails.textContent = `${state.me.deviceModel} • Port ${state.me.port}`;

    // 2. Fetch and render subnets/interfaces
    await refreshInterfaces();

    // 3. Bind UI interactions
    bindEvents();

    // 4. Register background event listeners from main process
    registerIpcListeners();

    // 5. Initialize transmit bottom bar
    updateTransmitButtonState();

    addLog('success', 'LANLink engine booted successfully. Ready to transmit.');
  } catch (err) {
    addLog('error', `Initialization failed: ${err.message}`);
  }
}

// --- Network Interfaces Helper ---
async function refreshInterfaces() {
  try {
    state.interfaces = await window.lanlink.getInterfaces();
    els.interfaceCount.textContent = state.interfaces.length;

    if (state.interfaces.length === 0) {
      els.localIpList.innerHTML = '<div class="empty-state-text">No active subnets found</div>';
      return;
    }

    els.localIpList.innerHTML = state.interfaces.map(iface => `
      <div class="local-ip-item ${iface.address === state.me.ip ? 'active' : ''}" data-ip="${escapeHtml(iface.address)}">
        <div class="ip-meta">
          <strong>${escapeHtml(iface.address)}</strong>
          <span>${escapeHtml(iface.name)}</span>
        </div>
        <span class="ip-badge ${escapeHtml(iface.type.toLowerCase())}">${escapeHtml(iface.type)}</span>
      </div>
    `).join('');

    // Bind click events to subnet items to switch active listening IP
    els.localIpList.querySelectorAll('.local-ip-item').forEach(el => {
      el.addEventListener('click', async () => {
        const ip = el.dataset.ip;
        try {
          const newIp = await window.lanlink.setActiveIp(ip);
          state.me.ip = newIp;
          addLog('info', `Active IP interface switched to: ${newIp}`);
          refreshInterfaces();
        } catch (e) {
          addLog('error', `Failed to switch active IP: ${e.message}`);
        }
      });
    });

  } catch (e) {
    addLog('error', `Failed to fetch network interfaces: ${e.message}`);
  }
}

// --- Bind DOM Events ---
function bindEvents() {
  // Tab Switching
  els.tabFilesBtn.addEventListener('click', () => switchTab('files'));
  els.tabTextBtn.addEventListener('click', () => switchTab('text'));

  // File Picking
  els.pickFileBtn.addEventListener('click', pickFile);
  els.fileDropzone.addEventListener('click', pickFile);

  // Drag and Drop files
  els.fileDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.fileDropzone.style.borderColor = 'var(--accent-cyan)';
  });

  els.fileDropzone.addEventListener('dragleave', () => {
    els.fileDropzone.style.borderColor = 'rgba(255, 255, 255, 0.08)';
  });

  els.fileDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.fileDropzone.style.borderColor = 'rgba(255, 255, 255, 0.08)';
    
    const file = e.dataTransfer.files[0];
    if (file) {
      selectLocalFile({
        path: file.path,
        name: file.name,
        size: file.size
      });
    }
  });

  // Clear Selected File
  els.clearFileBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // prevent triggering pickFile
    state.selectedFile = null;
    els.selectedFileCard.style.display = 'none';
    els.fileDropzone.style.display = 'flex';
    updateTransmitButtonState();
  });

  // Inline Chat Form submit
  els.textMessageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = els.textMessageInput.value.trim();
    if (!text || !state.selectedPeerId) return;

    els.textMessageInput.disabled = true;
    els.sendMsgBtn.disabled = true;

    try {
      await window.lanlink.sendMessage({
        text,
        targets: [state.selectedPeerId]
      });
      els.textMessageInput.value = '';
    } catch (err) {
      addLog('error', `Message send failed: ${err.message}`);
    } finally {
      els.textMessageInput.disabled = false;
      els.sendMsgBtn.disabled = false;
      els.textMessageInput.focus();
    }
  });

  // Connect manually by IP
  els.peerConnectForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ip = els.peerIpInput.value.trim();
    if (!ip) return;

    els.peerConnectBtn.disabled = true;
    addLog('info', `Manually probing peer at ${ip}...`);

    try {
      await window.lanlink.connectPeer(ip);
      els.peerIpInput.value = '';
    } catch (err) {
      addLog('error', `Manual connect to ${ip} failed: ${err.message}`);
    } finally {
      els.peerConnectBtn.disabled = false;
    }
  });

  // Rescan / Scan network button
  els.rescanBtn.addEventListener('click', async () => {
    els.rescanBtn.disabled = true;
    addLog('info', 'Triggering active LAN sweep (UDP Multicast + TCP scan)...');
    els.radarStatusText.textContent = 'Sweeping subnet ranges...';
    
    try {
      await window.lanlink.rescan();
    } catch (err) {
      addLog('error', `Network sweep failed: ${err.message}`);
    } finally {
      setTimeout(() => {
        els.rescanBtn.disabled = false;
        els.radarStatusText.textContent = 'Broadcasting announcements...';
      }, 2000);
    }
  });

  // Transmit Data Action (for files tab only now)
  els.transmitBtn.addEventListener('click', transmitData);

  // Invite Modal Action Buttons
  els.declineInviteBtn.addEventListener('click', declineIncomingInvite);
  els.acceptInviteBtn.addEventListener('click', acceptIncomingInvite);

  // Speed Chart Modal Listeners
  els.modalCloseBtn.addEventListener('click', window.closeSpeedChartModal);
  els.speedChartModal.addEventListener('click', (e) => {
    if (e.target === els.speedChartModal) {
      window.closeSpeedChartModal();
    }
  });

  // Clear Event Logs button
  els.clearLogBtn.addEventListener('click', () => {
    els.eventLog.innerHTML = '';
  });
}

// --- IPC Event Listeners from Main Process ---
function registerIpcListeners() {
  // Device list updates (discovered peers)
  window.lanlink.onDevices((devicesList) => {
    state.devices = devicesList;
    renderPeersGrid();
    
    // If our selected peer went offline, disable input
    if (state.selectedPeerId && !devicesList.some(d => d.id === state.selectedPeerId && d.status === 'online')) {
      state.selectedPeerId = null;
      renderChatMessages();
      updateTransmitButtonState();
    }
  });

  // Logs from backend
  window.lanlink.onLog((payload) => {
    addLog(payload.type, payload.message);
  });

  // Incoming Transfer invite modal trigger
  window.lanlink.onInvite((invite) => {
    state.currentInvite = invite;
    
    els.inviteSenderName.textContent = invite.sender.alias;
    els.inviteFileList.innerHTML = invite.files.map(f => `
      <div class="invite-file-item">
        <span class="invite-filename" title="${escapeHtml(f.fileName)}">${escapeHtml(f.fileName)}</span>
        <span class="badge">${formatBytes(f.size)}</span>
      </div>
    `).join('');

    els.incomingInviteModal.classList.add('open');
  });

  // Upload/Download file progress update
  window.lanlink.onFileProgress((progress) => {
    const existing = state.activeTransfers.get(progress.transferId) || { speedHistory: [] };
    const updated = { ...existing, ...progress };

    // Record speed history during active transfers
    if ((progress.status === 'sending' || progress.status === 'receiving') && progress.speedMbps !== undefined) {
      updated.speedHistory = existing.speedHistory || [];
      updated.speedHistory.push({
        time: Date.now(),
        speed: progress.speedMbps
      });
      if (updated.speedHistory.length > 40) {
        updated.speedHistory.shift();
      }
    }

    state.activeTransfers.set(progress.transferId, updated);
    renderTransmissions();

    // Real-time speed chart update if this session's modal is active
    if (state.activeChartSessionId === progress.transferId) {
      updateActiveChart(updated);
    }
  });

  // Handle incoming or sent chat message
  window.lanlink.onMessage((msg) => {
    state.chatHistory.push(msg);
    renderChatMessages();
    
    const isSent = msg.sender.id === state.me.id;
    if (!isSent) {
      addLog('success', `Message from ${msg.sender.alias}: "${msg.text}"`);
    }
  });
}

// --- UI Actions & Helper Functions ---

function switchTab(tab) {
  state.activeTab = tab;
  if (tab === 'files') {
    els.tabFilesBtn.classList.add('active');
    els.tabTextBtn.classList.remove('active');
    els.tabFilesContent.style.display = 'flex';
    els.tabTextContent.style.display = 'none';
    els.transmitBtn.style.display = 'inline-flex';
  } else {
    els.tabFilesBtn.classList.remove('active');
    els.tabTextBtn.classList.add('active');
    els.tabFilesContent.style.display = 'none';
    els.tabTextContent.style.display = 'block';
    els.transmitBtn.style.display = 'none'; // Chat has its own submit composer button
    
    renderChatMessages();
  }
  updateTransmitButtonState();
}

async function pickFile() {
  try {
    const file = await window.lanlink.pickFile();
    if (file) {
      selectLocalFile(file);
    }
  } catch (err) {
    addLog('error', `Failed to open file picker: ${err.message}`);
  }
}

function selectLocalFile(file) {
  state.selectedFile = file;
  els.selectedFileName.textContent = file.name;
  els.selectedFileSize.textContent = formatBytes(file.size);
  
  els.fileDropzone.style.display = 'none';
  els.selectedFileCard.style.display = 'flex';
  
  updateTransmitButtonState();
}

function selectPeer(peerId) {
  if (state.selectedPeerId === peerId) {
    state.selectedPeerId = null; // toggle selection off
  } else {
    state.selectedPeerId = peerId;
  }
  
  renderPeersGrid();
  renderChatMessages();
  updateTransmitButtonState();
}

function updateTransmitButtonState() {
  const peerSelected = state.selectedPeerId !== null;
  const fileSelected = state.selectedFile !== null;

  // Toggle bottom transmit button for files tab
  els.transmitBtn.disabled = !(peerSelected && fileSelected);

  // Toggle chat input state
  if (peerSelected) {
    els.textMessageInput.disabled = false;
    els.sendMsgBtn.disabled = false;
  } else {
    els.textMessageInput.disabled = true;
    els.sendMsgBtn.disabled = true;
    els.textMessageInput.value = '';
  }

  // Update target badge details
  if (peerSelected) {
    const peer = state.devices.find(d => d.id === state.selectedPeerId);
    if (peer) {
      els.selectedTargetBadge.textContent = peer.alias;
      els.selectedTargetBadge.classList.remove('empty');
    }
  } else {
    els.selectedTargetBadge.textContent = 'No device selected';
    els.selectedTargetBadge.classList.add('empty');
  }
}

// Transmit Data Action (REST POST to Peer HTTP Server for Files)
async function transmitData() {
  if (!state.selectedPeerId || state.activeTab !== 'files') return;
  
  const peer = state.devices.find(d => d.id === state.selectedPeerId);
  if (!peer) {
    addLog('error', 'Selected peer went offline or is invalid');
    return;
  }

  els.transmitBtn.disabled = true;

  const file = state.selectedFile;
  addLog('info', `Requesting transmission for: ${file.name} to ${peer.alias}...`);
  try {
    await window.lanlink.sendFile({
      path: file.path,
      targets: [peer.id]
    });
    addLog('success', `Finished sending ${file.name} to ${peer.alias}`);
    
    // Clear file selection
    state.selectedFile = null;
    els.selectedFileCard.style.display = 'none';
    els.fileDropzone.style.display = 'flex';
  } catch (err) {
    addLog('error', `Transmission failed: ${err.message}`);
  }

  updateTransmitButtonState();
}

// Incoming Invite Actions
async function acceptIncomingInvite() {
  if (!state.currentInvite) return;
  const sessionId = state.currentInvite.sessionId;
  
  els.incomingInviteModal.classList.remove('open');
  addLog('info', `Accepting incoming file invitation...`);

  try {
    const result = await window.lanlink.acceptInvite(sessionId);
    if (!result.ok) {
      addLog('error', `Accept invite failed: ${result.error}`);
    }
  } catch (err) {
    addLog('error', `Failed to accept invite: ${err.message}`);
  } finally {
    state.currentInvite = null;
  }
}

async function declineIncomingInvite() {
  if (!state.currentInvite) return;
  const sessionId = state.currentInvite.sessionId;
  
  els.incomingInviteModal.classList.remove('open');
  addLog('warning', `Declining incoming file invitation...`);

  try {
    await window.lanlink.declineInvite(sessionId);
  } catch (err) {
    addLog('error', `Failed to decline invite: ${err.message}`);
  } finally {
    state.currentInvite = null;
  }
}

// --- Render Functions ---

function renderPeersGrid() {
  const onlinePeers = state.devices.filter(d => d.status === 'online');
  
  if (onlinePeers.length === 0) {
    els.deviceList.innerHTML = '';
    els.radarContainer.style.display = 'flex';
    return;
  }

  // Hide the big radar scanner if we have discovered peers (so layout fits cards)
  els.radarContainer.style.display = 'none';

  els.deviceList.innerHTML = onlinePeers.map(peer => {
    const isSelected = state.selectedPeerId === peer.id;
    // Map device types to SVGs
    let avatarSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`; // default desktop
    if (peer.deviceType === 'mobile') {
      avatarSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`;
    }

    const rttValue = (peer.rtt !== undefined && peer.rtt > 0) ? `${peer.rtt}ms` : '—';
    const rttClass = peer.rtt < 60 ? 'ping-good' : (peer.rtt < 160 ? 'ping-medium' : 'ping-bad');

    return `
      <div class="peer-card ${isSelected ? 'selected' : ''}" onclick="selectPeer('${peer.id}')">
        <span class="peer-status-badge">
          <span class="badge-dot"></span>Online
        </span>
        <div class="peer-avatar">
          ${avatarSvg}
        </div>
        <h4 class="peer-alias" title="${escapeHtml(peer.alias)}">${escapeHtml(peer.alias)}</h4>
        <span class="peer-ip">${escapeHtml(peer.ip)}:${peer.port}</span>
        <div class="peer-card-footer">
          <span class="peer-type-tag">${escapeHtml(peer.deviceModel || peer.deviceType)}</span>
          <span class="peer-ping ${rttClass}">${rttValue}</span>
        </div>
      </div>
    `;
  }).join('');
}

// Render Chat Conversation history
function renderChatMessages() {
  if (!state.selectedPeerId) {
    els.chatMessages.innerHTML = `<div class="empty-state-text">Select a device to start chatting</div>`;
    return;
  }

  const selectedPeer = state.devices.find(d => d.id === state.selectedPeerId);
  const peerName = selectedPeer ? selectedPeer.alias : 'Peer';

  // Filter messages exchanged with selected peer
  const conversation = state.chatHistory.filter(msg => {
    const isSentToSelected = msg.sender.id === state.me.id && msg.receiverId === state.selectedPeerId;
    const isReceivedFromSelected = msg.sender.id === state.selectedPeerId;
    return isSentToSelected || isReceivedFromSelected;
  });

  if (conversation.length === 0) {
    els.chatMessages.innerHTML = `<div class="empty-state-text">No messages yet with <strong>${escapeHtml(peerName)}</strong>.<br>Send a message to start conversation!</div>`;
    return;
  }

  els.chatMessages.innerHTML = conversation.map(msg => {
    const isSent = msg.sender.id === state.me.id;
    const timeStr = new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="chat-bubble ${isSent ? 'sent' : 'received'}">
        <div class="chat-bubble-text">${escapeHtml(msg.text)}</div>
        <div class="chat-bubble-meta">${timeStr}</div>
      </div>
    `;
  }).join('');

  // Auto scroll to latest message
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

// Expose peer select helper to global scope for HTML inline onclick
window.selectPeer = selectPeer;

function renderTransmissions() {
  const list = Array.from(state.activeTransfers.values());
  const activeCount = list.filter(t => t.status === 'sending' || t.status === 'receiving').length;

  if (activeCount > 0) {
    els.activeTransmissionsBadge.textContent = `${activeCount} active`;
    els.activeTransmissionsBadge.style.color = 'var(--accent-cyan)';
    els.activeTransmissionsBadge.style.borderColor = 'rgba(34, 211, 238, 0.3)';
    els.activeTransmissionsBadge.style.background = 'rgba(34, 211, 238, 0.08)';
  } else {
    els.activeTransmissionsBadge.textContent = 'Idle';
    els.activeTransmissionsBadge.style.color = 'var(--text-faint)';
    els.activeTransmissionsBadge.style.borderColor = 'rgba(255, 255, 255, 0.08)';
    els.activeTransmissionsBadge.style.background = 'rgba(255, 255, 255, 0.02)';
  }

  if (list.length === 0) {
    els.transferList.innerHTML = `
      <div class="empty-state">
        <p class="muted">No active transfers</p>
      </div>
    `;
    return;
  }

  els.transferList.innerHTML = list.map(item => {
    let actionsHtml = '';
    const isActive = item.status === 'sending' || item.status === 'receiving' || item.status === 'paused';
    if (isActive) {
      const isPaused = item.status === 'paused';
      const pauseIcon = isPaused
        ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>` // Play
        : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`; // Pause
      
      actionsHtml = `
        <div class="transfer-actions">
          <button class="btn-icon-action" onclick="togglePauseTransfer(event, '${item.transferId}')" title="${isPaused ? 'Resume' : 'Pause'}">
            ${pauseIcon}
          </button>
          <button class="btn-icon-action cancel" onclick="cancelTransfer(event, '${item.transferId}')" title="Cancel">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      `;
    } else {
      actionsHtml = `
        <div class="transfer-actions">
          <button class="btn-icon-action delete" onclick="deleteTransfer(event, '${item.transferId}')" title="Remove from list">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          </button>
        </div>
      `;
    }

    return `
      <div class="transfer-card" onclick="openSpeedChartModal('${item.transferId}')" style="cursor: pointer;">
        <div class="transfer-card-header">
          <span class="transfer-filename" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
          ${actionsHtml}
          <span class="transfer-status-tag ${item.status}">${escapeHtml(item.status)}</span>
        </div>
        <div class="transfer-progress-track">
          <div class="transfer-progress-fill" style="width: ${item.progress}%"></div>
        </div>
        <div class="transfer-card-footer">
          <span>${Math.round(item.progress)}% • ${formatProgressBytes(item.transferred, item.size)}</span>
          <span>${item.speedMbps ? (item.speedMbps / 8).toFixed(2) + ' MB/s' : '0.00 MB/s'}</span>
        </div>
      </div>
    `;
  }).join('');
}

function addLog(type, message) {
  const time = new Date().toLocaleTimeString();
  const logRow = document.createElement('div');
  logRow.className = `log-entry ${type}`;
  logRow.innerHTML = `
    <span class="log-time">[${time}]</span>
    <span class="log-label">${escapeHtml(type)}:</span>
    <span class="log-text">${escapeHtml(message)}</span>
  `;
  
  els.eventLog.appendChild(logRow);
  els.eventLog.scrollTop = els.eventLog.scrollHeight;
}

// --- Utility Functions ---

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatProgressBytes(transferred, total, decimals = 2) {
  const t = +transferred || 0;
  const tot = +total || 0;
  if (!tot) return '0 Bytes / 0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(tot) / Math.log(k));
  
  const totalScaled = parseFloat((tot / Math.pow(k, i)).toFixed(dm));
  const transferredScaled = parseFloat((t / Math.pow(k, i)).toFixed(dm));
  
  return `${transferredScaled} / ${totalScaled} ${sizes[i]}`;
}

function escapeHtml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- Speed Chart Modal & Actions ---

window.openSpeedChartModal = function(transferId) {
  const item = state.activeTransfers.get(transferId);
  if (!item) return;

  state.activeChartSessionId = transferId;
  
  // Set modal texts
  els.chartModalTitle.textContent = item.name;
  
  // Open modal in DOM
  els.speedChartModal.classList.add('open');

  // Create Chart
  const ctx = document.getElementById('speedChartCanvas').getContext('2d');
  
  // Extract history
  const history = item.speedHistory || [];
  const data = history.map(h => h.speed / 8); // convert to MB/s
  const labels = history.map(() => '');

  // Destroy existing chart if any
  if (state.speedChartInstance) {
    state.speedChartInstance.destroy();
  }

  // Draw chart
  state.speedChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Speed (MB/s)',
        data: data,
        borderColor: '#22d3ee', // var(--accent-cyan)
        backgroundColor: 'rgba(34, 211, 238, 0.08)',
        borderWidth: 2,
        tension: 0.25,
        fill: true,
        pointRadius: 2,
        pointBackgroundColor: '#22d3ee'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: 'rgba(255, 255, 255, 0.4)', font: { size: 9 } }
        },
        y: {
          min: 0,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: 'rgba(255, 255, 255, 0.4)', font: { size: 9 } }
        }
      }
    }
  });

  // Perform initial update of text and buttons
  updateActiveChart(item);
};

window.closeSpeedChartModal = function() {
  els.speedChartModal.classList.remove('open');
  state.activeChartSessionId = null;
  if (state.speedChartInstance) {
    state.speedChartInstance.destroy();
    state.speedChartInstance = null;
  }
};

function updateActiveChart(item) {
  if (!state.speedChartInstance) return;

  const subtitleEl = document.getElementById('chartModalSubtitle');
  if (subtitleEl) {
    const statusText = item.status === 'sending' ? 'Sending' : (item.status === 'receiving' ? 'Receiving' : (item.status === 'paused' ? 'Paused' : item.status));
    subtitleEl.innerHTML = `${statusText} • ${Math.round(item.progress)}% • ${formatProgressBytes(item.transferred, item.size)} • ${item.speedMbps ? (item.speedMbps / 8).toFixed(2) + ' MB/s' : '0.00 MB/s'}`;
  }

  updateModalButtons(item);

  const history = item.speedHistory || [];
  const data = history.map(h => h.speed / 8); // convert to MB/s
  const labels = history.map(() => '');

  state.speedChartInstance.data.labels = labels;
  state.speedChartInstance.data.datasets[0].data = data;
  state.speedChartInstance.update('none'); // silent update (faster)
}

function updateModalButtons(item) {
  const isActive = item.status === 'sending' || item.status === 'receiving' || item.status === 'paused';
  if (isActive) {
    els.modalPauseBtn.style.display = 'inline-block';
    els.modalCancelBtn.style.display = 'inline-block';
    els.modalDeleteBtn.style.display = 'none';

    els.modalPauseBtn.textContent = item.status === 'paused' ? 'Resume' : 'Pause';
    
    // Set up click handlers dynamically for the modal buttons
    els.modalPauseBtn.onclick = (e) => window.togglePauseTransfer(e, item.transferId);
    els.modalCancelBtn.onclick = (e) => {
      window.cancelTransfer(e, item.transferId);
      window.closeSpeedChartModal();
    };
  } else {
    els.modalPauseBtn.style.display = 'none';
    els.modalCancelBtn.style.display = 'none';
    els.modalDeleteBtn.style.display = 'inline-block';

    els.modalDeleteBtn.onclick = (e) => {
      window.deleteTransfer(e, item.transferId);
      window.closeSpeedChartModal();
    };
  }
}

window.togglePauseTransfer = async function(event, transferId) {
  if (event) event.stopPropagation();
  try {
    const result = await window.lanlink.togglePauseTransfer(transferId);
    if (!result.ok) {
      addLog('error', `Failed to pause/resume: ${result.error}`);
    }
  } catch (err) {
    addLog('error', `Pause/Resume failed: ${err.message}`);
  }
};

window.cancelTransfer = async function(event, transferId) {
  if (event) event.stopPropagation();
  try {
    const result = await window.lanlink.cancelTransfer(transferId);
    if (!result.ok) {
      addLog('error', `Failed to cancel transfer: ${result.error}`);
    }
  } catch (err) {
    addLog('error', `Cancel transfer failed: ${err.message}`);
  }
};

window.deleteTransfer = function(event, transferId) {
  if (event) event.stopPropagation();
  state.activeTransfers.delete(transferId);
  renderTransmissions();
};
