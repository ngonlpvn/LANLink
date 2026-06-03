const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const dgram = require('dgram');
const http = require('http');
const { Server } = require('socket.io');
const { io: Client } = require('socket.io-client');

const APP_PORT = Number(process.env.LANLINK_PORT || 32150);
const DISCOVERY_PORT = Number(process.env.LANLINK_DISCOVERY_PORT || 41234);
const DISCOVERY_MAGIC = 'LANLINK_HOST_V1';
const PING_INTERVAL_MS = 1000;
const OFFLINE_TIMEOUT_MS = 5000;
const DISCOVERY_WAIT_MS = 2500;

let mainWindow;
let udpSocket;
let httpServer;
let ioServer;
let socketClient;
let discoveryTimer;
let broadcastTimer;
let pingTimer;
let offlineTimer;
let role = 'Scanning';
let hostInfo = null;
let userSelectedIp = null;

const device = createLocalDevice();
const devices = new Map();
const pendingFiles = new Map();

function createLocalDevice() {
  return {
    id: `${os.hostname()}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: os.hostname(),
    ip: getLanIp(),
    role: 'Scanning',
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
        list.push({ name, address: entry.address, type });
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

function publicDevices() {
  return Array.from(devices.values()).sort((a, b) => {
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
    backgroundColor: '#f0f4f8',
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
  devices.set(device.id, device);
  setupUdpDiscovery();
  log('info', 'LAN scanning started');
  discoveryTimer = setTimeout(() => {
    if (!hostInfo) becomeHost();
  }, DISCOVERY_WAIT_MS);
}

function setupUdpDiscovery() {
  udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  udpSocket.on('message', (buffer, rinfo) => {
    try {
      const message = JSON.parse(buffer.toString());
      if (message.magic !== DISCOVERY_MAGIC || message.deviceId === device.id) return;
      if (!hostInfo && role !== 'Host') {
        hostInfo = { ip: rinfo.address, port: message.port, id: message.deviceId, name: message.name };
        clearTimeout(discoveryTimer);
        log('success', `Host found: ${message.name} at ${rinfo.address}`);
        connectToHost(hostInfo);
      }
      if (role === 'Host' && message.deviceId < device.id) {
        log('warning', `Another host was detected: ${message.name}`);
      }
    } catch (error) {
      log('error', 'Invalid discovery packet received', { error: error.message });
    }
  });

  udpSocket.on('error', (error) => log('error', 'UDP discovery error', { error: error.message }));
  udpSocket.bind(DISCOVERY_PORT, () => udpSocket.setBroadcast(true));
}

function becomeHost() {
  if (role === 'Host') return;
  hostInfo = { ip: device.ip, port: APP_PORT, id: device.id, name: device.name };
  role = 'Host';
  device.role = 'Host';
  upsertDevice(device);
  log('warning', 'No host found');

  httpServer = http.createServer();
  ioServer = new Server(httpServer, {
    cors: { origin: '*' },
    maxHttpBufferSize: 1e8
  });

  ioServer.on('connection', (socket) => {
    let registeredId = null;

    socket.on('device:hello', (hello) => {
      registeredId = hello.id;
      upsertDevice({ ...hello, role: hello.id === device.id ? 'Host' : 'Client', status: 'online' });
      socket.join(hello.id);
      socket.emit('devices:update', publicDevices());
      socket.broadcast.emit('devices:update', publicDevices());
      if (hello.id !== device.id) log('success', `Client connected: ${hello.name}`);
    });

    socket.on('message:send', (payload) => {
      const message = { ...payload, id: `${Date.now()}-${Math.random()}`, time: Date.now() };
      routeToTargets('message:received', message.targets, message);
      log('info', 'Message sent', { targets: message.targets });
    });

    socket.on('file:start', (payload) => {
      routeToTargets('file:start', payload.targets, payload);
      log('info', `File transfer started: ${payload.name}`);
    });

    socket.on('file:chunk', (payload) => {
      routeToTargets('file:chunk', payload.targets, payload);
    });

    socket.on('file:end', (payload) => {
      routeToTargets('file:end', payload.targets, payload);
      log('success', `File transfer completed: ${payload.name}`);
    });

    socket.on('file:progress:report', (payload) => {
      if (payload.senderId === device.id) {
        sendToRenderer('file:progress', payload);
      } else {
        ioServer.to(payload.senderId).emit('file:progress:report', payload);
      }
    });

    socket.on('webrtc:signal', (payload) => {
      ioServer.to(payload.to).emit('webrtc:signal', payload);
    });

    socket.on('call:event', (payload) => {
      routeToTargets('call:event', payload.targets, payload);
    });

    socket.on('ping:client', (payload, ack) => {
      if (ack) ack({ time: payload.time });
    });

    socket.on('disconnect', () => {
      if (registeredId && devices.has(registeredId)) {
        const offline = { ...devices.get(registeredId), status: 'offline', rtt: 0 };
        devices.set(registeredId, offline);
        emitDevices();
        if (registeredId !== device.id) log('warning', `Client disconnected: ${offline.name}`);
      }
    });
  });

  httpServer.listen(APP_PORT, '0.0.0.0', () => {
    log('success', 'This device became host');
    startHostBroadcast();
    connectToHost({ ip: '127.0.0.1', port: APP_PORT, id: device.id, name: device.name });
  });

  httpServer.on('error', (error) => {
    log('error', 'Host server failed to start', { error: error.message });
  });
}

function routeToTargets(event, targets, payload) {
  const onlineTargets = (targets || []).filter((id) => devices.get(id)?.status === 'online');
  for (const target of onlineTargets) ioServer.to(target).emit(event, payload);
}

function startHostBroadcast() {
  clearInterval(broadcastTimer);
  const packet = Buffer.from(JSON.stringify({
    magic: DISCOVERY_MAGIC,
    deviceId: device.id,
    name: device.name,
    ip: device.ip,
    port: APP_PORT,
    time: Date.now()
  }));
  broadcastTimer = setInterval(() => {
    if (udpSocket) udpSocket.send(packet, 0, packet.length, DISCOVERY_PORT, '255.255.255.255');
  }, 1000);
}

function connectToHost(host) {
  role = host.id === device.id ? 'Host' : 'Client';
  device.role = role;
  device.ip = getLanIp();
  upsertDevice(device);

  const url = `http://${host.ip}:${host.port}`;
  socketClient = Client(url, { reconnection: true, reconnectionAttempts: 4, timeout: 3000 });

  socketClient.on('connect', () => {
    log('success', `Connected to host ${host.name}`);
    socketClient.emit('device:hello', device);
    sendToRenderer('lan:status', { role, localIp: device.ip, connected: true, host });
    startPingLoop();
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
    for (const item of list) devices.set(item.id, item);
    emitDevices();
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
  log('warning', 'Host connection lost permanently. Re-scanning LAN...');
  shutdownRuntime();
  hostInfo = null;
  role = 'Scanning';
  device.role = 'Scanning';
  device.rtt = 0;
  devices.clear();
  devices.set(device.id, device);
  emitDevices();
  sendToRenderer('lan:status', { role, localIp: device.ip, connected: false, host: null });
  startLanRuntime();
}

function startPingLoop() {
  clearInterval(pingTimer);
  clearInterval(offlineTimer);

  pingTimer = setInterval(() => {
    if (!socketClient?.connected) return;
    const started = Date.now();
    socketClient.timeout(900).emit('ping:client', { from: device.id, time: started }, (error) => {
      if (error) return;
      device.rtt = Date.now() - started;
      device.lastSeen = Date.now();
      upsertDevice(device);
      socketClient.emit('device:hello', device);
      log('info', 'Ping RTT updated', { rtt: device.rtt });
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

ipcMain.handle('chat:send', (_event, payload) => {
  socketClient?.emit('message:send', { ...payload, sender: device });
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
  socketClient.emit('file:start', info);
  const stream = fs.createReadStream(payload.path, { highWaterMark: 64 * 1024 });
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
      sendToRenderer('file:progress', {
        ...info,
        receiverId: 'sender-upload',
        received: sent,
        progress: (sent / stat.size) * 100,
        speedMbps,
        status: isFinished ? 'completed' : 'sending'
      });
    }
  }

  socketClient.emit('file:end', info);
  sendToRenderer('file:progress', { ...info, receiverId: 'sender-upload', received: stat.size, progress: 100, speedMbps: 0, status: 'completed' });
});

ipcMain.handle('webrtc:signal', (_event, payload) => {
  socketClient?.emit('webrtc:signal', { ...payload, from: device.id });
});

ipcMain.handle('call:event', (_event, payload) => {
  socketClient?.emit('call:event', { ...payload, from: device.id, sender: device });
});

function shutdownRuntime() {
  clearTimeout(discoveryTimer);
  clearInterval(broadcastTimer);
  clearInterval(pingTimer);
  clearInterval(offlineTimer);
  socketClient?.close();
  socketClient = null;
  ioServer?.close();
  ioServer = null;
  httpServer?.close();
  httpServer = null;
  udpSocket?.close();
  udpSocket = null;
}
