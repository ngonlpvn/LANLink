const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const { io: Client } = require('socket.io-client');

const APP_PORT = Number(process.env.LANLINK_PORT || 32150);
const PING_INTERVAL_MS = 3000;
const OFFLINE_TIMEOUT_MS = 12000;
const SOCKET_ACK_TIMEOUT_MS = 5000;

let mainWindow;
let httpServer;
let ioServer;
let socketClient;
let pingTimer;
let offlineTimer;
let lastPingLogAt = 0;
let role = 'Ready';
let hostInfo = null;
let userSelectedIp = null;
let pairedPeerIp = null;
let hostReadyPromise = null;

const device = createLocalDevice();
const devices = new Map();
const pendingFiles = new Map();

function createLocalDevice() {
  return {
    id: `${os.hostname()}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: os.hostname(),
    ip: getLanIp(),
    role: 'Ready',
    status: 'online',
    rtt: 0,
    connectedAt: Date.now(),
    lastSeen: Date.now()
  };
}

function getNetworkInterfaces() {
  const nets = os.networkInterfaces();
  const list = [];
  for (const [name, entries] of Object.entries(nets)) {
    if (/virtual|vbox|vmnet|docker|vpn|wsl|p2p/i.test(name)) continue;
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        let type = 'LAN';
        if (/wl|wlan|wifi|wireless/i.test(name) || name === 'en0') {
          type = 'Wi-Fi';
        } else if (/eth|ether|lan|en[1-9]/i.test(name)) {
          type = 'LAN';
        }
        list.push({
          name,
          address: entry.address,
          netmask: entry.netmask,
          type
        });
      }
    }
  }

  // Sort: prioritize type === 'LAN' first, then 'Wi-Fi'
  return list.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'LAN' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function getLanIp() {
  if (userSelectedIp) {
    const list = getNetworkInterfaces();
    if (list.some(i => i.address === userSelectedIp)) {
      return userSelectedIp;
    }
  }
  const list = getNetworkInterfaces();
  return list[0]?.address || '127.0.0.1';
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function log(type, message, meta = {}) {
  sendToRenderer('lan:log', { time: Date.now(), type, message, meta });
}

function ackOk(ack, payload = {}) {
  if (typeof ack === 'function') ack({ ok: true, ...payload });
}

function ackFail(ack, error) {
  if (typeof ack === 'function') ack({ ok: false, error: error?.message || String(error) });
}

function emitWithAck(event, payload, timeout = SOCKET_ACK_TIMEOUT_MS) {
  if (!socketClient?.connected) {
    return Promise.reject(new Error('Not connected to a host'));
  }
  return socketClient.timeout(timeout).emitWithAck(event, payload);
}

function isValidIpv4(ip) {
  const parts = String(ip || '').trim().split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function publicDevices() {
  const local = devices.get(device.id) || device;
  const remotes = Array.from(devices.values())
    .filter((item) => item.id !== device.id)
    .filter((item) => {
      if (pairedPeerIp) return item.ip === pairedPeerIp;
      return item.status === 'online';
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'online' ? -1 : 1;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });
  const pair = [local];
  if (remotes[0]) pair.push(remotes[0]);
  return pair.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'online' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function emitDevices() {
  const list = publicDevices();
  sendToRenderer('lan:devices', list);
  if (ioServer) ioServer.emit('devices:update', list);
}

function upsertDevice(next) {
  const current = devices.get(next.id) || {};
  const wasOnline = current.status === 'online';
  const isOnline = (next.status || 'online') === 'online';

  devices.set(next.id, {
    ...current,
    ...next,
    lastSeen: Date.now(),
    status: next.status || 'online'
  });

  if (!wasOnline && isOnline && next.id !== device.id) {
    log('success', `Device online: ${next.name}`);
  }

  emitDevices();
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#081018',
    title: 'LANLink',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  await createWindow();
  log('info', 'App started');
  startLanRuntime();
});

app.on('window-all-closed', () => {
  shutdownRuntime();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function startLanRuntime() {
  device.ip = getLanIp();
  device.status = 'online';
  device.role = 'Host';
  device.lastSeen = Date.now();
  devices.set(device.id, device);
  log('info', 'Manual peer mode started');
  becomeHost();
}

function stopHostServices() {
  clearInterval(pingTimer);
  clearInterval(offlineTimer);
  socketClient?.close();
  socketClient = null;
  ioServer?.close();
  ioServer = null;
  httpServer?.close();
  httpServer = null;
}

function becomeHost() {
  if (httpServer || ioServer) return hostReadyPromise || Promise.resolve();
  hostReadyPromise = new Promise((resolve) => {
    hostInfo = { ip: device.ip, port: APP_PORT, id: device.id, name: device.name };
    role = 'Host';
    device.role = 'Host';
    upsertDevice(device);

    httpServer = http.createServer();
    ioServer = new Server(httpServer, {
      cors: { origin: '*' },
      maxHttpBufferSize: 1e8
    });

    ioServer.on('connection', (socket) => {
    let registeredId = null;

    socket.on('device:hello', (hello) => {
      const current = devices.get(hello.id);
      const shouldLogConnection = hello.id !== device.id && (!current || current.status !== 'online');
      registeredId = hello.id;
      upsertDevice({ ...hello, role: hello.id === device.id ? 'Host' : 'Client', status: 'online' });
      socket.join(hello.id);
      socket.emit('devices:update', publicDevices());
      socket.broadcast.emit('devices:update', publicDevices());
      if (shouldLogConnection) log('success', `Client connected: ${hello.name}`);
    });

    socket.on('message:send', (payload, ack) => {
      try {
        const message = { ...payload, id: `${Date.now()}-${Math.random()}`, time: Date.now() };
        const delivered = routeToTargets('message:received', message.targets, message);
        log('info', 'Message sent', { targets: message.targets, delivered });
        ackOk(ack, { delivered });
      } catch (error) {
        log('error', 'Message send failed', { error: error.message });
        ackFail(ack, error);
      }
    });

    socket.on('file:start', (payload, ack) => {
      try {
        const delivered = routeToTargets('file:start', payload.targets, payload);
        log('info', `File transfer started: ${payload.name}`);
        ackOk(ack, { delivered });
      } catch (error) {
        ackFail(ack, error);
      }
    });

    socket.on('file:chunk', (payload, ack) => {
      try {
        const delivered = routeToTargets('file:chunk', payload.targets, payload);
        ackOk(ack, { delivered });
      } catch (error) {
        ackFail(ack, error);
      }
    });

    socket.on('file:end', (payload, ack) => {
      try {
        const delivered = routeToTargets('file:end', payload.targets, payload);
        log('success', `File transfer completed: ${payload.name}`);
        ackOk(ack, { delivered });
      } catch (error) {
        ackFail(ack, error);
      }
    });

    socket.on('file:progress:report', (payload) => {
      if (payload.senderId === device.id) {
        sendToRenderer('file:progress', payload);
      } else {
        ioServer.to(payload.senderId).emit('file:progress:report', payload);
      }
    });

    socket.on('webrtc:signal', (payload, ack) => {
      try {
        if (payload.to === device.id) {
          sendToRenderer('webrtc:signal', payload);
        } else {
          ioServer.to(payload.to).emit('webrtc:signal', payload);
        }
        ackOk(ack);
      } catch (error) {
        ackFail(ack, error);
      }
    });

    socket.on('call:event', (payload, ack) => {
      try {
        const delivered = routeToTargets('call:event', payload.targets, payload);
        ackOk(ack, { delivered });
      } catch (error) {
        ackFail(ack, error);
      }
    });

    socket.on('ping:client', (payload, ack) => {
      if (ack) ack({ time: payload.time });
    });

    socket.on('disconnect', () => {
      if (registeredId && devices.has(registeredId)) {
        if (registeredId === device.id) return;
        const offline = { ...devices.get(registeredId), status: 'offline', rtt: 0 };
        devices.set(registeredId, offline);
        emitDevices();
        if (registeredId !== device.id) log('warning', `Client disconnected: ${offline.name}`);
      }
    });
    });

    httpServer.listen(APP_PORT, '0.0.0.0', () => {
      log('success', 'Ready for manual peer connection');
      sendToRenderer('lan:status', { role, localIp: device.ip, connected: false, host: hostInfo });
      connectToHost({ ip: '127.0.0.1', port: APP_PORT, id: device.id, name: device.name });
      resolve();
    });

    httpServer.on('error', (error) => {
      log('error', 'Local server failed to start', { error: error.message });
      resolve();
    });
  });
  return hostReadyPromise;
}

function routeToTargets(event, targets, payload) {
  const onlineTargets = (targets || []).filter((id) => devices.get(id)?.status === 'online');
  let delivered = 0;
  for (const target of onlineTargets) {
    if (target === device.id) {
      deliverLocalEvent(event, payload);
      delivered += 1;
      continue;
    }
    ioServer.to(target).emit(event, payload);
    delivered += 1;
  }
  return delivered;
}

function deliverLocalEvent(event, payload) {
  if (event === 'message:received') {
    log('success', 'Message received');
    sendToRenderer('chat:message', payload);
    return;
  }
  if (event === 'file:start') {
    handleIncomingFileStart(payload);
    return;
  }
  if (event === 'file:chunk') {
    handleIncomingFileChunk(payload);
    return;
  }
  if (event === 'file:end') {
    handleIncomingFileEnd(payload);
    return;
  }
  if (event === 'call:event') {
    sendToRenderer('call:event', payload);
  }
}

function connectToHost(host) {
  if (socketClient) {
    socketClient.removeAllListeners();
    socketClient.close();
    socketClient = null;
  }
  role = host.id === device.id ? 'Host' : 'Client';
  device.role = role;
  device.ip = getLanIp();
  upsertDevice(device);

  const url = `http://${host.ip}:${host.port}`;
  socketClient = Client(url, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 3000,
    timeout: 5000
  });

  socketClient.on('connect', () => {
    log('success', host.id === device.id ? 'Local server bridge ready' : `Connected to peer ${host.name}`);
    socketClient.emit('device:hello', device);
    sendToRenderer('lan:status', { role, localIp: device.ip, connected: true, host });
    if (host.id !== device.id) startPingLoop();
  });

  socketClient.on('disconnect', () => {
    log('warning', 'Disconnected from host');
    sendToRenderer('lan:status', { role, localIp: device.ip, connected: false, host });
  });

  socketClient.on('reconnect_failed', () => {
    handleHostLost();
  });

  socketClient.on('connect_error', (error) => log('error', 'Host connection error', { error: error.message }));
  socketClient.on('devices:update', (list) => {
    let changed = false;
    for (const item of list) {
      if (item.id === device.id) continue;
      const current = devices.get(item.id) || {};
      devices.set(item.id, {
        ...current,
        ...item,
        lastSeen: Date.now()
      });
      changed = true;
    }
    if (changed) emitDevices();
  });
  socketClient.on('message:received', (payload) => {
    log('success', 'Message received');
    sendToRenderer('chat:message', payload);
  });
  socketClient.on('file:start', handleIncomingFileStart);
  socketClient.on('file:chunk', handleIncomingFileChunk);
  socketClient.on('file:end', handleIncomingFileEnd);
  socketClient.on('file:progress:report', (payload) => sendToRenderer('file:progress', payload));
  socketClient.on('webrtc:signal', (payload) => sendToRenderer('webrtc:signal', payload));
  socketClient.on('call:event', (payload) => sendToRenderer('call:event', payload));
}

function handleHostLost() {
  log('warning', 'Peer connection lost. Enter the peer IP and connect again if needed.');
  device.rtt = 0;
  for (const item of devices.values()) {
    if (item.id !== device.id) {
      item.status = 'offline';
      item.rtt = 0;
    }
  }
  emitDevices();
  sendToRenderer('lan:status', { role: 'Host', localIp: device.ip, connected: false, host: hostInfo });
}

function startPingLoop() {
  clearInterval(pingTimer);
  clearInterval(offlineTimer);

  pingTimer = setInterval(() => {
    if (!socketClient?.connected) return;
    const started = Date.now();
    socketClient.timeout(2000).emit('ping:client', { from: device.id, time: started }, (error) => {
      if (error) return;
      const nextRtt = Date.now() - started;
      const smoothed = device.rtt ? (device.rtt * 0.7) + (nextRtt * 0.3) : nextRtt;
      device.rtt = Math.max(1, Math.round(smoothed / 5) * 5);
      device.lastSeen = Date.now();
      upsertDevice(device);
      socketClient.emit('device:hello', device);
      if (Date.now() - lastPingLogAt > 10000) {
        lastPingLogAt = Date.now();
        log('info', 'Ping RTT updated', { rtt: device.rtt });
      }
    });
  }, PING_INTERVAL_MS);

  offlineTimer = setInterval(() => {
    if (!ioServer) return;
    let changed = false;
    for (const item of devices.values()) {
      if (item.id === device.id) continue;
      if (item.status === 'online' && Date.now() - item.lastSeen > OFFLINE_TIMEOUT_MS) {
        item.status = 'offline';
        item.rtt = 0;
        changed = true;
        log('warning', `Device offline: ${item.name}`);
      }
    }
    if (changed) emitDevices();
  }, 1500);
}

function handleIncomingFileStart(payload) {
  const dir = path.join(app.getPath('downloads'), 'LANLinkReceived');
  fs.mkdirSync(dir, { recursive: true });
  const safeName = payload.name.replace(/[\\/:*?"<>|]/g, '_');
  const filePath = path.join(dir, `${Date.now()}-${safeName}`);
  pendingFiles.set(payload.transferId, {
    ...payload,
    filePath,
    stream: fs.createWriteStream(filePath),
    received: 0,
    startedAt: Date.now(),
    lastReportedAt: 0
  });
  log('info', `Receiving file: ${payload.name}`);
  
  const progressInfo = {
    transferId: payload.transferId,
    receiverId: device.id,
    senderId: payload.sender.id,
    name: payload.name,
    size: payload.size,
    progress: 0,
    speedMbps: 0,
    avgSpeedMbps: 0,
    status: 'receiving'
  };
  sendToRenderer('file:progress', progressInfo);
  socketClient?.emit('file:progress:report', progressInfo);
}

function handleIncomingFileChunk(payload) {
  const transfer = pendingFiles.get(payload.transferId);
  if (!transfer) return;
  const chunk = Buffer.from(payload.chunk);
  transfer.stream.write(chunk);
  transfer.received += chunk.length;

  if (!transfer.inProgressLogged) {
    transfer.inProgressLogged = true;
    log('info', `File transfer in progress: ${transfer.name}`);
  }
  
  const now = Date.now();
  const elapsed = Math.max(1, now - transfer.startedAt) / 1000;
  const speedMbps = (transfer.received * 8) / elapsed / 1000000;
  const avgSpeedMbps = speedMbps;
  const progress = Math.min(100, (transfer.received / transfer.size) * 100);
  
  const isFinished = transfer.received >= transfer.size;
  const isFirst = transfer.received === chunk.length;
  
  if (isFirst || isFinished || now - transfer.lastReportedAt >= 150) {
    transfer.lastReportedAt = now;
    
    const progressInfo = {
      transferId: transfer.transferId,
      receiverId: device.id,
      senderId: transfer.sender.id,
      name: transfer.name,
      size: transfer.size,
      progress,
      speedMbps,
      avgSpeedMbps,
      status: 'receiving'
    };
    sendToRenderer('file:progress', progressInfo);
    socketClient?.emit('file:progress:report', progressInfo);
  }
}

function handleIncomingFileEnd(payload) {
  const transfer = pendingFiles.get(payload.transferId);
  if (!transfer) return;
  transfer.stream.end();
  pendingFiles.delete(payload.transferId);
  log('success', `File saved: ${transfer.filePath}`);
  
  const progressInfo = {
    transferId: transfer.transferId,
    receiverId: device.id,
    senderId: transfer.sender.id,
    name: transfer.name,
    size: transfer.size,
    progress: 100,
    speedMbps: 0,
    avgSpeedMbps: 0,
    status: 'completed',
    filePath: transfer.filePath
  };
  sendToRenderer('file:progress', progressInfo);
  socketClient?.emit('file:progress:report', progressInfo);
}

ipcMain.handle('app:get-info', () => ({
  id: device.id,
  name: device.name,
  ip: getLanIp(),
  role,
  port: APP_PORT
}));

ipcMain.handle('app:get-interfaces', () => getNetworkInterfaces());

ipcMain.handle('app:set-active-ip', (_event, ip) => {
  userSelectedIp = ip;
  device.ip = getLanIp();
  upsertDevice(device);
  if (socketClient?.connected) {
    socketClient.emit('device:hello', device);
  }
  log('info', `Active IP changed to: ${device.ip}`);
  return device.ip;
});

ipcMain.handle('dialog:pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const stat = fs.statSync(filePath);
  return { path: filePath, name: path.basename(filePath), size: stat.size };
});

ipcMain.handle('chat:send', async (_event, payload) => {
  const result = await emitWithAck('message:send', { ...payload, sender: device });
  if (result?.ok === false) throw new Error(result.error || 'Message send failed');
  if ((result?.delivered || 0) < (payload.targets || []).length) {
    throw new Error(`Message delivered to ${result?.delivered || 0}/${(payload.targets || []).length} target(s)`);
  }
  return result;
});

ipcMain.handle('file:send', async (_event, payload) => {
  if (!socketClient?.connected) throw new Error('Not connected to a host');
  const transferId = payload.transferId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stat = fs.statSync(payload.path);
  const info = {
    transferId,
    name: path.basename(payload.path),
    size: stat.size,
    sender: device,
    targets: payload.targets,
    startedAt: Date.now()
  };
  const startResult = await emitWithAck('file:start', info);
  if (startResult?.ok === false) throw new Error(startResult.error || 'File transfer failed to start');
  if ((startResult?.delivered || 0) < (payload.targets || []).length) {
    throw new Error(`File transfer started on ${startResult?.delivered || 0}/${(payload.targets || []).length} target(s)`);
  }
  const stream = fs.createReadStream(payload.path, { highWaterMark: 32 * 1024 });
  let sent = 0;
  const startedAt = Date.now();
  let lastReportedAt = 0;
  let inProgressLogged = false;

  for await (const chunk of stream) {
    sent += chunk.length;
    socketClient.emit('file:chunk', { ...info, chunk, sent });

    if (!inProgressLogged) {
      inProgressLogged = true;
      log('info', `File transfer in progress: ${info.name}`);
    }
    
    const now = Date.now();
    const isFinished = sent >= stat.size;
    const isFirst = sent === chunk.length;
    
    if (isFirst || isFinished || now - lastReportedAt >= 150) {
      lastReportedAt = now;
      const elapsed = Math.max(1, now - startedAt) / 1000;
      const speedMbps = (sent * 8) / elapsed / 1000000;
      const avgSpeedMbps = speedMbps;
      sendToRenderer('file:progress', {
        ...info,
        receiverId: 'sender-upload',
        received: sent,
        progress: (sent / stat.size) * 100,
        speedMbps,
        avgSpeedMbps,
        status: isFinished ? 'completed' : 'sending'
      });
    }
  }

  const endResult = await emitWithAck('file:end', info, 15000);
  if (endResult?.ok === false) throw new Error(endResult.error || 'File transfer failed to finish');
  sendToRenderer('file:progress', { ...info, receiverId: 'sender-upload', received: stat.size, progress: 100, speedMbps: 0, avgSpeedMbps: 0, status: 'completed' });
});

ipcMain.handle('webrtc:signal', async (_event, payload) => {
  const result = await emitWithAck('webrtc:signal', { ...payload, from: device.id });
  if (result?.ok === false) throw new Error(result.error || 'WebRTC signaling failed');
  return result;
});

ipcMain.handle('call:event', async (_event, payload) => {
  const result = await emitWithAck('call:event', { ...payload, from: device.id, sender: device });
  if (result?.ok === false) throw new Error(result.error || 'Call event failed');
  return result;
});

ipcMain.handle('lan:connect-peer', async (_event, ip) => {
  const peerIp = String(ip || '').trim();
  if (!isValidIpv4(peerIp)) throw new Error('Invalid peer IP address');
  device.ip = getLanIp();
  if (peerIp === device.ip || peerIp === '127.0.0.1') {
    throw new Error('Peer IP must be the other computer, not this device');
  }
  pairedPeerIp = peerIp;
  devices.clear();
  devices.set(device.id, { ...device, status: 'online', lastSeen: Date.now() });
  emitDevices();
  await becomeHost();
  log('info', `Connecting to peer ${peerIp}`);
  connectToHost({ ip: peerIp, port: APP_PORT, id: null, name: peerIp });
  sendToRenderer('lan:status', { role: 'Client', localIp: device.ip, connected: false, host: { ip: peerIp, port: APP_PORT } });
  return { ok: true, ip: peerIp };
});

function shutdownRuntime() {
  clearInterval(pingTimer);
  clearInterval(offlineTimer);
  socketClient?.close();
  socketClient = null;
  ioServer?.close();
  ioServer = null;
  httpServer?.close();
  httpServer = null;
}
