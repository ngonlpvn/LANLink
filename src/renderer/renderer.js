const state = {
  me: null,
  status: { role: 'Scanning', localIp: 'Detecting...', connected: false },
  devices: [],
  selectedTargets: new Set(),
  messages: [],
  transfers: new Map(),
  selectedFile: null,
  localStream: null,
  peer: null,
  activeCallTarget: null,
  micEnabled: true,
  camEnabled: true,
  chart: null,
  iceCandidatesQueue: [],
  displayedAvgPing: 0
};

const els = {
  roleValue: document.querySelector('#roleValue'),
  ipSelector: document.querySelector('#ipSelector'),
  connectionValue: document.querySelector('#connectionValue'),
  onlineValue: document.querySelector('#onlineValue'),
  pingValue: document.querySelector('#pingValue'),
  deviceCountLabel: document.querySelector('#deviceCountLabel'),
  deviceList: document.querySelector('#deviceList'),
  targetSummary: document.querySelector('#targetSummary'),
  localNameChip: document.querySelector('#localNameChip'),
  chatHistory: document.querySelector('#chatHistory'),
  chatForm: document.querySelector('#chatForm'),
  messageInput: document.querySelector('#messageInput'),
  pickFileBtn: document.querySelector('#pickFileBtn'),
  sendFileBtn: document.querySelector('#sendFileBtn'),
  fileName: document.querySelector('#fileName'),
  fileSize: document.querySelector('#fileSize'),
  transferList: document.querySelector('#transferList'),
  eventLog: document.querySelector('#eventLog'),
  rescanBtn: document.querySelector('#rescanBtn'),
  peerConnectForm: document.querySelector('#peerConnectForm'),
  peerIpInput: document.querySelector('#peerIpInput'),
  peerConnectBtn: document.querySelector('#peerConnectBtn'),
  selectAllBtn: document.querySelector('#selectAllBtn'),
  clearTargetsBtn: document.querySelector('#clearTargetsBtn'),
  clearLogBtn: document.querySelector('#clearLogBtn'),
  currentSpeed: document.querySelector('#currentSpeed'),
  startCallBtn: document.querySelector('#startCallBtn'),
  endCallBtn: document.querySelector('#endCallBtn'),
  micBtn: document.querySelector('#micBtn'),
  camBtn: document.querySelector('#camBtn'),
  callStatus: document.querySelector('#callStatus'),
  callDot: document.querySelector('#callDot'),
  localVideo: document.querySelector('#localVideo'),
  remoteVideo: document.querySelector('#remoteVideo')
};

boot();

async function boot() {
  state.me = await window.lanlink.getInfo();
  els.localNameChip.textContent = state.me.name;

  const interfaces = await window.lanlink.getInterfaces();
  els.ipSelector.innerHTML = interfaces.map(i => `
    <option value="${escapeHtml(i.address)}">${escapeHtml(i.address)} (${escapeHtml(i.type)})</option>
  `).join('');
  if (state.me.ip) els.ipSelector.value = state.me.ip;

  initChart();
  bindEvents();
  renderAll();
  setInterval(updateChartTelemetry, 1000);
}

function bindEvents() {
  window.lanlink.onStatus((status) => {
    state.status = status;
    renderStatus();
  });

  window.lanlink.onDevices((devices) => {
    state.devices = devices;
    for (const id of [...state.selectedTargets]) {
      if (!devices.find((device) => device.id === id && device.status === 'online')) state.selectedTargets.delete(id);
    }
    const remotes = onlineRemoteDevices();
    if (remotes.length === 1 && state.selectedTargets.size === 0) {
      state.selectedTargets.add(remotes[0].id);
    }
    renderStatus();
    renderDevices();
    renderTargets();
  });

  window.lanlink.onLog(addLog);

  window.lanlink.onMessage((message) => {
    state.messages.push(message);
    renderMessages();
  });

  window.lanlink.onFileProgress((progress) => {
    const key = `${progress.transferId}:${progress.receiverId || 'unknown'}`;
    state.transfers.set(key, progress);
    renderTransfers();
  });

  window.lanlink.onSignal(handleSignal);
  window.lanlink.onCallEvent(handleCallEvent);

  els.selectAllBtn.addEventListener('click', () => {
    for (const device of onlineRemoteDevices()) state.selectedTargets.add(device.id);
    renderAll();
  });

  els.clearTargetsBtn.addEventListener('click', () => {
    state.selectedTargets.clear();
    renderAll();
  });

  els.rescanBtn.addEventListener('click', async () => {
    els.rescanBtn.disabled = true;
    addLog({ type: 'info', message: 'Reloading LAN scan...', time: Date.now() });
    try {
      state.selectedTargets.clear();
      state.transfers.clear();
      await window.lanlink.rescan();
      renderAll();
    } catch (error) {
      addLog({ type: 'error', message: `Reload scan failed: ${error.message}`, time: Date.now() });
    } finally {
      setTimeout(() => {
        els.rescanBtn.disabled = false;
      }, 1200);
    }
  });

  els.peerConnectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const ip = els.peerIpInput.value.trim();
    if (!ip) return addLog({ type: 'warning', message: 'Enter the other computer IP first', time: Date.now() });
    els.peerConnectBtn.disabled = true;
    try {
      state.selectedTargets.clear();
      state.transfers.clear();
      await window.lanlink.connectPeer(ip);
      addLog({ type: 'info', message: `Connecting to peer ${ip}`, time: Date.now() });
      renderAll();
    } catch (error) {
      addLog({ type: 'error', message: `Peer connect failed: ${error.message}`, time: Date.now() });
    } finally {
      setTimeout(() => {
        els.peerConnectBtn.disabled = false;
      }, 1200);
    }
  });

  els.clearLogBtn.addEventListener('click', () => {
    els.eventLog.innerHTML = '';
  });

  els.chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = els.messageInput.value.trim();
    const targets = [...state.selectedTargets];
    if (!text || targets.length === 0) return addLog({ type: 'warning', message: 'Select at least one target before sending a message', time: Date.now() });

    const message = {
      sender: state.me,
      targets,
      text,
      time: Date.now()
    };
    state.messages.push(message);
    renderMessages();
    els.messageInput.value = '';
    try {
      await window.lanlink.sendMessage(message);
      addLog({ type: 'success', message: 'Message sent', time: Date.now() });
    } catch (error) {
      addLog({ type: 'error', message: `Message send failed: ${error.message}`, time: Date.now() });
    }
  });

  els.pickFileBtn.addEventListener('click', async () => {
    state.selectedFile = await window.lanlink.pickFile();
    renderSelectedFile();
  });

  els.sendFileBtn.addEventListener('click', async () => {
    const targets = [...state.selectedTargets];
    if (!state.selectedFile || targets.length === 0) return addLog({ type: 'warning', message: 'Select a file and at least one target', time: Date.now() });
    const transferId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    
    // Initialize UI bars
    state.transfers.set(`${transferId}:sender-upload`, {
      transferId,
      receiverId: 'sender-upload',
      name: state.selectedFile.name,
      size: state.selectedFile.size,
      progress: 0,
      speedMbps: 0,
      avgSpeedMbps: 0,
      status: 'starting'
    });
    for (const targetId of targets) {
      state.transfers.set(`${transferId}:${targetId}`, {
        transferId,
        receiverId: targetId,
        name: state.selectedFile.name,
        size: state.selectedFile.size,
        progress: 0,
        speedMbps: 0,
        avgSpeedMbps: 0,
        status: 'pending'
      });
    }
    renderTransfers();

    try {
      await window.lanlink.sendFile({ ...state.selectedFile, targets, transferId });
      addLog({ type: 'success', message: 'File transfer completed', time: Date.now() });
    } catch (error) {
      addLog({ type: 'error', message: `File transfer failed: ${error.message}`, time: Date.now() });
      const up = state.transfers.get(`${transferId}:sender-upload`);
      if (up) up.status = 'failed';
      for (const targetId of targets) {
        const tr = state.transfers.get(`${transferId}:${targetId}`);
        if (tr) tr.status = 'failed';
      }
      renderTransfers();
    }
  });

  els.startCallBtn.addEventListener('click', startCall);
  els.endCallBtn.addEventListener('click', endCall);
  els.micBtn.addEventListener('click', toggleMic);
  els.camBtn.addEventListener('click', toggleCam);

  els.ipSelector.addEventListener('change', async () => {
    const newIp = els.ipSelector.value;
    const updatedIp = await window.lanlink.setActiveIp(newIp);
    state.me.ip = updatedIp;
    renderStatus();
  });
}

function renderAll() {
  renderStatus();
  renderDevices();
  renderTargets();
  renderSelectedFile();
  renderMessages();
  renderTransfers();
}

function renderStatus() {
  const online = onlineRemoteDevices();
  const avgPing = average(online.filter((device) => device.rtt > 0).map((device) => device.rtt));
  if (avgPing > 0) {
    state.displayedAvgPing = state.displayedAvgPing
      ? (state.displayedAvgPing * 0.72) + (avgPing * 0.28)
      : avgPing;
  } else if (!online.length) {
    state.displayedAvgPing = 0;
  }
  els.roleValue.textContent = state.status.role || state.me?.role || 'Scanning';
  if (els.ipSelector) els.ipSelector.value = state.status.localIp || state.me?.ip || '';
  els.connectionValue.textContent = state.status.connected ? 'Connected' : 'Scanning LAN';
  els.connectionValue.className = `status-text ${state.status.connected ? 'success' : 'warning'}`;
  els.onlineValue.textContent = online.length;
  els.pingValue.textContent = `${Math.round(state.displayedAvgPing)} ms`;
  els.deviceCountLabel.textContent = `${online.length} peer online`;
}

function renderDevices() {
  if (!state.devices.length) {
    els.deviceList.innerHTML = '<div class="empty-state">Scanning for LANLink devices...</div>';
    return;
  }

  // Remove empty state if present
  if (els.deviceList.querySelector('.empty-state')) {
    els.deviceList.innerHTML = '';
  }

  // Remove elements that are no longer in devices list
  const currentIds = new Set(state.devices.map(d => d.id));
  for (const card of els.deviceList.querySelectorAll('.device-card')) {
    if (!currentIds.has(card.dataset.id)) {
      card.remove();
    }
  }

  state.devices.forEach((device) => {
    const selected = state.selectedTargets.has(device.id);
    const isMe = device.id === state.me?.id;
    
    // Find existing card
    let card = els.deviceList.querySelector(`.device-card[data-id="${CSS.escape(device.id)}"]`);
    
    if (!card) {
      card = document.createElement('article');
      card.className = 'device-card';
      card.dataset.id = device.id;
      
      card.innerHTML = `
        <div class="device-top">
          <div class="device-name">
            <span class="status-dot"></span>
            <span class="name-text"></span>
          </div>
          <span class="role-chip"></span>
        </div>
        <span class="device-ip"></span>
        <span class="device-id"></span>
        <div class="device-meta">
          <span class="device-rtt"></span>
          <span class="device-duration"></span>
        </div>
      `;
      
      card.addEventListener('click', () => {
        const latest = state.devices.find((item) => item.id === card.dataset.id);
        if (!latest || latest.id === state.me?.id || latest.status !== 'online') return;
        if (state.selectedTargets.has(latest.id)) state.selectedTargets.delete(latest.id);
        else state.selectedTargets.add(latest.id);
        renderAll();
      });
      
      els.deviceList.appendChild(card);
    }
    
    // Update card state classes
    card.className = `device-card ${selected ? 'selected' : ''} ${device.status}`;
    
    // Update contents inside card
    const dot = card.querySelector('.status-dot');
    dot.className = `status-dot ${device.status}`;
    
    card.querySelector('.name-text').textContent = `${device.name}${isMe ? ' (you)' : ''}`;
    
    const roleChip = card.querySelector('.role-chip');
    roleChip.className = `role-chip ${device.role === 'Host' ? 'host' : 'client'}`;
    roleChip.textContent = device.role || 'Client';
    
    card.querySelector('.device-ip').textContent = device.ip || '0.0.0.0';
    card.querySelector('.device-id').textContent = device.id;
    card.querySelector('.device-rtt').textContent = `${device.rtt || 0} ms RTT`;
    card.querySelector('.device-duration').textContent = formatDuration(Date.now() - (device.connectedAt || Date.now()));
  });
}

function renderTargets() {
  const selected = state.devices.filter((device) => state.selectedTargets.has(device.id));
  if (!selected.length) els.targetSummary.textContent = 'No targets selected';
  else els.targetSummary.textContent = selected.map((device) => device.name).join(', ');
  els.sendFileBtn.disabled = !state.selectedFile || selected.length === 0;
}

function renderSelectedFile() {
  els.fileName.textContent = state.selectedFile?.name || 'No file selected';
  els.fileSize.textContent = state.selectedFile ? formatBytes(state.selectedFile.size) : '0 B';
  els.sendFileBtn.disabled = !state.selectedFile || state.selectedTargets.size === 0;
}

function renderMessages() {
  if (!state.messages.length) {
    els.chatHistory.innerHTML = '<div class="empty-state">Select LAN targets and send your first message.</div>';
    return;
  }

  els.chatHistory.innerHTML = state.messages.map((message) => {
    const sent = message.sender?.id === state.me?.id;
    const receivers = (message.targets || []).map((id) => deviceName(id)).join(', ');
    return `
      <div class="chat-message ${sent ? 'sent' : 'received'}">
        <div class="chat-meta">${escapeHtml(message.sender?.name || 'Unknown')} -> ${escapeHtml(receivers || 'You')} · ${formatTime(message.time)}</div>
        <div>${escapeHtml(message.text)}</div>
      </div>
    `;
  }).join('');
  els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
}

function renderTransfers() {
  const transfers = [...state.transfers.values()].slice(-30).reverse();
  if (!transfers.length) {
    els.transferList.innerHTML = '<div class="empty-state">File transfers will appear here with per-device progress.</div>';
    return;
  }

  els.transferList.innerHTML = transfers.map((transfer) => {
    let receiver = transfer.receiverId;
    if (receiver === 'sender-upload') {
      receiver = 'Uploading to LAN';
    } else if (receiver === 'all-targets') {
      receiver = 'Selected targets';
    } else {
      receiver = deviceName(receiver);
    }
    const progress = Math.max(0, Math.min(100, transfer.progress || 0));
    return `
      <article class="transfer-item">
        <div class="transfer-head">
          <div class="transfer-title">${escapeHtml(transfer.name || 'File')}</div>
          <span class="chip">${escapeHtml(transfer.status || 'pending')}</span>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
        <div class="transfer-meta">
          <span>${escapeHtml(receiver)} · ${progress.toFixed(0)}%</span>
          <span>${(transfer.speedMbps || 0).toFixed(2)} Mbps · Avg ${(transfer.avgSpeedMbps || transfer.speedMbps || 0).toFixed(2)} Mbps</span>
        </div>
      </article>
    `;
  }).join('');
}

function initChart() {
  const ctx = document.querySelector('#speedChart');
  state.chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Transfer Mbps',
        data: [],
        borderColor: '#22d3ee',
        backgroundColor: 'rgba(34, 211, 238, 0.16)',
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          ticks: { color: '#8ea2b4', maxTicksLimit: 6 },
          grid: { color: 'rgba(142, 162, 180, 0.09)' }
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#8ea2b4' },
          grid: { color: 'rgba(142, 162, 180, 0.09)' }
        }
      }
    }
  });
}

function addChartPoint(speed) {
  const labels = state.chart.data.labels;
  const data = state.chart.data.datasets[0].data;
  labels.push(new Date().toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' }));
  data.push(Number(speed.toFixed(2)));
  while (labels.length > 28) {
    labels.shift();
    data.shift();
  }
  els.currentSpeed.textContent = `${speed.toFixed(2)} Mbps`;
  state.chart.update();
}

function updateChartTelemetry() {
  let totalSpeed = 0;
  for (const transfer of state.transfers.values()) {
    if (transfer.status === 'sending' || transfer.status === 'receiving') {
      totalSpeed += (transfer.speedMbps || 0);
    }
  }
  addChartPoint(totalSpeed);
}

async function startCall() {
  const target = [...state.selectedTargets][0];
  if (!target) return addLog({ type: 'warning', message: 'Select one online device before starting a call', time: Date.now() });
  try {
    await ensureMedia();
    createPeer(target);
    state.activeCallTarget = target;
    const offer = await state.peer.createOffer();
    await state.peer.setLocalDescription(offer);
    await window.lanlink.sendSignal({ to: target, type: 'offer', description: offer });
    await window.lanlink.sendCallEvent({ targets: [target], kind: 'started' });
    setCallStatus(`Calling ${deviceName(target)}`, true);
    addLog({ type: 'success', message: 'Voice call started', time: Date.now() });
  } catch (error) {
    addLog({ type: 'error', message: `Call failed: ${error.message}`, time: Date.now() });
  }
}

async function handleSignal(payload) {
  if (!payload.from || payload.from === state.me?.id) return;
  try {
    await ensureMedia();
    if (!state.peer) createPeer(payload.from);
    state.activeCallTarget = payload.from;

    if (payload.type === 'offer') {
      await state.peer.setRemoteDescription(payload.description);
      const answer = await state.peer.createAnswer();
      await state.peer.setLocalDescription(answer);
      await window.lanlink.sendSignal({ to: payload.from, type: 'answer', description: answer });
      setCallStatus(`In call with ${deviceName(payload.from)}`, true);
      const isVideo = state.camEnabled && state.localStream && state.localStream.getVideoTracks().length > 0;
      addLog({ type: 'success', message: `${isVideo ? 'Video' : 'Voice'} call started`, time: Date.now() });
      
      // Process buffered candidates
      for (const candidate of state.iceCandidatesQueue) {
        await state.peer.addIceCandidate(candidate).catch(err => console.warn("Buffered candidate error:", err));
      }
      state.iceCandidatesQueue = [];
    }

    if (payload.type === 'answer') {
      await state.peer.setRemoteDescription(payload.description);
      setCallStatus(`In call with ${deviceName(payload.from)}`, true);
      
      // Process buffered candidates
      for (const candidate of state.iceCandidatesQueue) {
        await state.peer.addIceCandidate(candidate).catch(err => console.warn("Buffered candidate error:", err));
      }
      state.iceCandidatesQueue = [];
    }

    if (payload.type === 'candidate' && payload.candidate) {
      if (state.peer && state.peer.remoteDescription) {
        await state.peer.addIceCandidate(payload.candidate).catch(err => console.warn("Direct candidate error:", err));
      } else {
        state.iceCandidatesQueue.push(payload.candidate);
      }
    }
  } catch (error) {
    addLog({ type: 'error', message: `WebRTC signal error: ${error.message}`, time: Date.now() });
  }
}

function createPeer(target) {
  closePeer({ stopMedia: false });
  state.peer = new RTCPeerConnection({
    iceServers: [],
    iceCandidatePoolSize: 4
  });
  if (state.localStream) {
    for (const track of state.localStream.getTracks()) state.peer.addTrack(track, state.localStream);
  }
  state.peer.onicecandidate = (event) => {
    if (event.candidate) window.lanlink.sendSignal({ to: target, type: 'candidate', candidate: event.candidate });
  };
  state.peer.ontrack = (event) => {
    els.remoteVideo.srcObject = event.streams[0];
  };
  state.peer.onconnectionstatechange = () => {
    const connectionState = state.peer?.connectionState;
    if (connectionState === 'connected') {
      setCallStatus(`In call with ${deviceName(state.activeCallTarget)}`, true);
      addLog({ type: 'success', message: 'WebRTC peer connected', time: Date.now() });
    }
    if (['failed', 'closed', 'disconnected'].includes(connectionState)) endCall();
  };
}

async function ensureMedia() {
  if (state.localStream) return;
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: state.camEnabled });
  } catch (err) {
    console.warn("Failed to get audio and video, trying audio only:", err);
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err2) {
      console.error("Failed to acquire any media:", err2);
      throw new Error("Microphone or Webcam access denied/unavailable.");
    }
  }
  els.localVideo.srcObject = state.localStream;
  applyMediaToggles();
}

async function toggleMic() {
  state.micEnabled = !state.micEnabled;
  if (state.micEnabled) {
    await ensureMedia().catch(err => console.error("Mic toggle media error:", err));
  }
  applyMediaToggles();
  addLog({ type: 'info', message: state.micEnabled ? 'Microphone enabled' : 'Microphone disabled', time: Date.now() });
}

async function toggleCam() {
  state.camEnabled = !state.camEnabled;
  if (state.camEnabled) {
    await ensureMedia().catch(err => console.error("Cam toggle media error:", err));
  }
  applyMediaToggles();
  addLog({ type: 'info', message: state.camEnabled ? 'Webcam enabled' : 'Webcam disabled', time: Date.now() });
}

function applyMediaToggles() {
  if (state.localStream) {
    for (const track of state.localStream.getAudioTracks()) track.enabled = state.micEnabled;
    for (const track of state.localStream.getVideoTracks()) track.enabled = state.camEnabled;
    
    // Release hardware if both mic and camera are disabled and we are NOT in a call
    if (!state.micEnabled && !state.camEnabled && !state.activeCallTarget) {
      for (const track of state.localStream.getTracks()) {
        try {
          track.stop();
        } catch (e) {}
      }
      state.localStream = null;
      els.localVideo.srcObject = null;
    }
  }
  els.micBtn.classList.toggle('active', state.micEnabled);
  els.camBtn.classList.toggle('active', state.camEnabled);
}

async function endCall() {
  const target = state.activeCallTarget;
  const isVideo = state.camEnabled && state.localStream && state.localStream.getVideoTracks().length > 0;
  closePeer();
  setCallStatus('Idle', false);
  if (target) await window.lanlink.sendCallEvent({ targets: [target], kind: 'ended' });
  addLog({ type: 'warning', message: `${isVideo ? 'Video' : 'Voice'} call ended`, time: Date.now() });
}

function closePeer(options = {}) {
  const { stopMedia = true } = options;
  if (state.peer) {
    try {
      state.peer.close();
    } catch (e) {}
  }
  state.peer = null;
  state.activeCallTarget = null;
  els.remoteVideo.srcObject = null;
  state.iceCandidatesQueue = [];
  
  if (stopMedia && state.localStream) {
    for (const track of state.localStream.getTracks()) {
      try {
        track.stop();
      } catch (e) {}
    }
    state.localStream = null;
  }
  els.localVideo.srcObject = null;
}

function handleCallEvent(payload) {
  if (payload.kind === 'ended') {
    const isVideo = state.camEnabled && state.localStream && state.localStream.getVideoTracks().length > 0;
    closePeer();
    setCallStatus('Idle', false);
    addLog({ type: 'warning', message: `${isVideo ? 'Video' : 'Voice'} call ended`, time: Date.now() });
  }
}

function setCallStatus(text, active) {
  els.callStatus.textContent = text;
  els.callDot.className = `status-dot ${active ? 'online' : 'offline'}`;
  els.startCallBtn.disabled = active;
  els.endCallBtn.disabled = !active;
}

function addLog(entry) {
  const row = document.createElement('div');
  row.className = `log-row ${entry.type || 'info'}`;
  row.innerHTML = `
    <span class="log-time">${formatTime(entry.time || Date.now())}</span>
    <span class="log-type">${escapeHtml(entry.type || 'info')}</span>
    <span>${escapeHtml(entry.message || '')}</span>
  `;
  els.eventLog.prepend(row);
  while (els.eventLog.children.length > 160) els.eventLog.lastElementChild.remove();
}

function onlineRemoteDevices() {
  return state.devices.filter((device) => device.status === 'online' && device.id !== state.me?.id);
}

function deviceName(id) {
  return state.devices.find((device) => device.id === id)?.name || id || 'Unknown';
}

function average(numbers) {
  if (!numbers.length) return 0;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
}

function formatTime(time) {
  return new Date(time).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
