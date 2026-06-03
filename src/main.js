const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const url = require('url');

// Port configurations
let APP_PORT = 53317;
const UDP_PORT = 53317;
const MULTICAST_ADDR = '224.0.0.167';

let mainWindow;
let httpServer;
let udpSocket;
let scanTimer;
let announceTimer;
let cleanupTimer;

const device = createLocalDevice();
const devices = new Map(); // fingerprint -> device info
const pendingIncomingSessions = new Map(); // sessionId -> session object
const pendingOutgoingSessions = new Map(); // sessionId -> session object
let activeIncomingSession = null; // Currently active receive session

function createLocalDevice() {
  const hostname = os.hostname();
  const id = crypto.createHash('sha256').update(`${hostname}-${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16);
  return {
    id,
    name: hostname,
    alias: `${hostname} (LANLink)`,
    ip: '127.0.0.1',
    port: APP_PORT,
    deviceModel: os.type() === 'Darwin' ? 'macOS' : 'Windows',
    deviceType: 'desktop',
    protocol: 'http',
    download: false,
    status: 'online',
    lastSeen: Date.now()
  };
}

function getNetworkInterfaces() {
  const nets = os.networkInterfaces();
  const list = [];
  for (const [name, entries] of Object.entries(nets)) {
    // Filter out loopbacks, virtual, VPN, Docker, and other non-physical interfaces
    if (/virtual|vbox|vmnet|docker|vpn|wsl|p2p|loopback|gif|stf|bridge/i.test(name)) continue;
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

  // Prioritize Ethernet (LAN) then Wi-Fi
  return list.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'LAN' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function getLanIp() {
  const list = getNetworkInterfaces();
  return list[0]?.address || '127.0.0.1';
}

function getSubnetIps(ip, netmask) {
  const ips = [];
  const ipParts = ip.split('.').map(Number);
  const maskParts = netmask.split('.').map(Number);

  if (ipParts.length !== 4 || maskParts.length !== 4) return ips;

  // We optimize for the standard /24 subnet scanning, which covers 99% of home networks.
  // This is safe, extremely fast, and avoids scanning 65k IPs on /16 subnets.
  const prefix = ipParts.slice(0, 3).join('.');
  for (let i = 1; i <= 254; i++) {
    const candidate = `${prefix}.${i}`;
    if (candidate !== ip) {
      ips.push(candidate);
    }
  }
  return ips;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function log(type, message, meta = {}) {
  sendToRenderer('lan:log', { time: Date.now(), type, message, meta });
}

function emitDevices() {
  const list = Array.from(devices.values())
    .filter(d => d.id !== device.id)
    .map(d => ({
      ...d,
      status: Date.now() - d.lastSeen < 12000 ? 'online' : 'offline'
    }));
  sendToRenderer('lan:devices', list);
}

function upsertDevice(remote) {
  if (remote.id === device.id || remote.fingerprint === device.id) return;
  const id = remote.id || remote.fingerprint;
  const current = devices.get(id) || {};
  devices.set(id, {
    ...current,
    id,
    alias: remote.alias || remote.name || 'Unknown Device',
    deviceModel: remote.deviceModel || 'Unknown',
    deviceType: remote.deviceType || 'desktop',
    ip: remote.ip,
    port: remote.port || 53317,
    protocol: remote.protocol || 'http',
    download: remote.download || false,
    lastSeen: Date.now(),
    status: 'online'
  });
  emitDevices();
}

// HTTP Helper to parse JSON body
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', (err) => reject(err));
  });
}

// HTTP Server implementation (LocalSend compatible)
function startHttpServer() {
  return new Promise((resolve) => {
    const tryBind = (port) => {
      httpServer = http.createServer((req, res) => {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;
        const method = req.method;

        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // POST /api/localsend/v2/register
        if (pathname === '/api/localsend/v2/register' && method === 'POST') {
          parseJsonBody(req).then((body) => {
            const clientIp = req.socket.remoteAddress.replace(/^.*:/, ''); // IPv4 mapping format fix
            upsertDevice({ ...body, ip: clientIp });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              alias: device.alias,
              version: '2.0',
              deviceModel: device.deviceModel,
              deviceType: device.deviceType,
              fingerprint: device.id,
              port: device.port,
              protocol: 'http',
              download: false
            }));
          }).catch(err => {
            res.writeHead(400);
            res.end('Bad Request');
          });
        }
        // GET /api/localsend/v2/info
        else if (pathname === '/api/localsend/v2/info' && method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            alias: device.alias,
            version: '2.0',
            deviceModel: device.deviceModel,
            deviceType: device.deviceType,
            fingerprint: device.id,
            port: device.port,
            protocol: 'http',
            download: false
          }));
        }
        // POST /api/localsend/v2/prepare-upload
        else if (pathname === '/api/localsend/v2/prepare-upload' && method === 'POST') {
          parseJsonBody(req).then((body) => {
            if (activeIncomingSession) {
              res.writeHead(409); // Conflict
              res.end('Another session is active');
              return;
            }

            const sender = body.info;
            const files = body.files;
            const clientIp = req.socket.remoteAddress.replace(/^.*:/, '');
            sender.ip = clientIp;

            const sessionId = crypto.randomBytes(16).toString('hex');
            const fileTokens = {};
            const filesMap = new Map();

            for (const [fileId, fileInfo] of Object.entries(files)) {
              const token = crypto.randomBytes(16).toString('hex');
              fileTokens[fileId] = token;
              filesMap.set(fileId, {
                ...fileInfo,
                token,
                received: 0,
                status: 'pending'
              });
            }

            // Check if this is a chat message (text.txt and size < 64KB)
            const isTextMessage = Object.values(files).every(f => f.fileName === 'text.txt' && f.fileType === 'text/plain' && f.size < 65536);

            if (isTextMessage) {
              // Auto-accept text messages to make chat feel instant and fluid
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                sessionId,
                files: fileTokens
              }));

              const session = {
                sessionId,
                sender,
                files: filesMap,
                res: null, // no pending HTTP response to resolve later
                fileTokens,
                isText: true
              };

              activeIncomingSession = session;
              pendingIncomingSessions.set(sessionId, session);
              return;
            }

            const session = {
              sessionId,
              sender,
              files: filesMap,
              res,
              fileTokens,
              isText: false
            };

            activeIncomingSession = session;
            pendingIncomingSessions.set(sessionId, session);

            // Notify renderer of incoming invite
            sendToRenderer('lan:invite', {
              sessionId,
              sender: {
                alias: sender.alias,
                deviceModel: sender.deviceModel,
                deviceType: sender.deviceType,
                ip: sender.ip
              },
              files: Object.values(files)
            });

            log('warning', `Incoming transfer request from ${sender.alias} (${Object.keys(files).length} files)`);

          }).catch(err => {
            res.writeHead(400);
            res.end('Bad Request');
          });
        }
        // POST /api/localsend/v2/upload
        else if (pathname === '/api/localsend/v2/upload' && method === 'POST') {
          const { sessionId, fileId, token } = parsedUrl.query;
          const session = activeIncomingSession;

          if (!session || session.sessionId !== sessionId) {
            res.writeHead(403);
            res.end('Invalid Session');
            return;
          }

          const file = session.files.get(fileId);
          if (!file || file.token !== token) {
            res.writeHead(403);
            res.end('Invalid File Token');
            return;
          }

          // Handle in-memory chat message buffer instead of disk write
          if (session.isText) {
            let bodyBuffer = [];
            req.on('data', (chunk) => {
              bodyBuffer.push(chunk);
            });
            req.on('end', () => {
              const textContent = Buffer.concat(bodyBuffer).toString('utf8');
              
              // Emit chat:message to renderer
              sendToRenderer('chat:message', {
                id: `${Date.now()}-${Math.random()}`,
                sender: { id: session.sender.fingerprint || session.sender.id, alias: session.sender.alias },
                receiverId: device.id,
                text: textContent,
                time: Date.now()
              });
              
              // Clean up session
              activeIncomingSession = null;
              pendingIncomingSessions.delete(sessionId);
              
              res.writeHead(200);
              res.end('OK');
            });
            
            req.on('error', (err) => {
              activeIncomingSession = null;
              pendingIncomingSessions.delete(sessionId);
              res.writeHead(500);
              res.end('Error');
            });
            return;
          }

          const dir = path.join(app.getPath('downloads'), 'LANLinkReceived');
          fs.mkdirSync(dir, { recursive: true });
          const safeName = file.fileName.replace(/[\\/:*?"<>|]/g, '_');
          const filePath = path.join(dir, `${Date.now()}-${safeName}`);

          const writeStream = fs.createWriteStream(filePath);
          file.status = 'uploading';
          file.filePath = filePath;

          let received = 0;
          const startedAt = Date.now();
          let lastReportedAt = Date.now();

          req.on('data', (chunk) => {
            writeStream.write(chunk);
            received += chunk.length;
            file.received = received;

            const now = Date.now();
            if (now - lastReportedAt >= 150) {
              lastReportedAt = now;
              const elapsed = (now - startedAt) / 1000 || 0.001;
              const speedMbps = (received * 8) / elapsed / 1000000;
              sendToRenderer('file:progress', {
                transferId: sessionId,
                receiverId: device.id,
                senderId: session.sender.fingerprint,
                name: file.fileName,
                size: file.size,
                progress: (received / file.size) * 100,
                speedMbps,
                avgSpeedMbps: speedMbps,
                status: 'receiving'
              });
            }
          });

          req.on('end', () => {
            writeStream.end();
            file.status = 'completed';
            log('success', `File received: ${file.fileName}`);

            sendToRenderer('file:progress', {
              transferId: sessionId,
              receiverId: device.id,
              senderId: session.sender.fingerprint,
              name: file.fileName,
              size: file.size,
              progress: 100,
              speedMbps: 0,
              avgSpeedMbps: 0,
              status: 'completed',
              filePath
            });

            // Check if all files in the session are completed
            let allFinished = true;
            for (const f of session.files.values()) {
              if (f.status !== 'completed' && f.status !== 'failed') {
                allFinished = false;
                break;
              }
            }

            if (allFinished) {
              log('success', 'All file transfers completed');
              activeIncomingSession = null;
              pendingIncomingSessions.delete(sessionId);
            }

            res.writeHead(200);
            res.end('OK');
          });

          req.on('error', (err) => {
            writeStream.end();
            file.status = 'failed';
            log('error', `Error receiving file ${file.fileName}: ${err.message}`);
            res.writeHead(500);
            res.end('Internal Server Error');
          });
        }
        // POST /api/localsend/v2/cancel
        else if (pathname === '/api/localsend/v2/cancel' && method === 'POST') {
          const { sessionId } = parsedUrl.query;
          const session = activeIncomingSession;

          if (session && session.sessionId === sessionId) {
            log('warning', `Transfer canceled by sender`);
            activeIncomingSession = null;
            pendingIncomingSessions.delete(sessionId);
            sendToRenderer('file:progress', {
              transferId: sessionId,
              status: 'canceled'
            });
          }
          res.writeHead(200);
          res.end('OK');
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      httpServer.listen(port, '0.0.0.0', () => {
        device.port = port;
        APP_PORT = port;
        log('success', `Local HTTP server running on port ${port}`);
        resolve(port);
      });

      httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < 53327) {
          log('info', `Port ${port} in use, trying next...`);
          tryBind(port + 1);
        } else {
          log('error', `Failed to start HTTP server: ${err.message}`);
          resolve(null);
        }
      });
    };

    tryBind(APP_PORT);
  });
}

// UDP Multicast setup
function startUdpDiscovery() {
  udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  udpSocket.on('message', (buffer, rinfo) => {
    try {
      const msg = JSON.parse(buffer.toString());
      if (msg.fingerprint === device.id) return; // ignore self
      
      const remoteIp = rinfo.address;
      upsertDevice({ ...msg, ip: remoteIp });

      // If the incoming packet is an active announcement request, respond back so they see us too
      if (msg.announcement === true) {
        respondToUdpAnnouncement(remoteIp, msg.port);
      }
    } catch (e) {
      // Ignore malformed packets
    }
  });

  udpSocket.on('error', (err) => {
    log('error', `UDP discovery error: ${err.message}`);
  });

  udpSocket.bind(UDP_PORT, () => {
    try {
      udpSocket.setBroadcast(true);
      // Join multicast group on all active physical interfaces
      const interfaces = getNetworkInterfaces();
      for (const iface of interfaces) {
        try {
          udpSocket.addMembership(MULTICAST_ADDR, iface.address);
        } catch (e) {
          // Multicast join failed on this interface (e.g. not multicast-capable)
        }
      }
      log('info', 'UDP Multicast discovery listening');
    } catch (e) {
      log('error', `Failed to initialize UDP Multicast: ${e.message}`);
    }
  });
}

function respondToUdpAnnouncement(ip, port) {
  try {
    const payload = Buffer.from(JSON.stringify({
      alias: device.alias,
      version: '2.0',
      deviceModel: device.deviceModel,
      deviceType: device.deviceType,
      fingerprint: device.id,
      port: device.port,
      protocol: 'http',
      announcement: false
    }));
    const client = dgram.createSocket('udp4');
    client.send(payload, 0, payload.length, port, ip, () => {
      client.close();
    });
  } catch (e) {
    // Ignore send failures
  }
}

function sendUdpAnnouncement() {
  if (!udpSocket) return;

  const payload = Buffer.from(JSON.stringify({
    alias: device.alias,
    version: '2.0',
    deviceModel: device.deviceModel,
    deviceType: device.deviceType,
    fingerprint: device.id,
    port: device.port,
    protocol: 'http',
    announcement: true
  }));

  const interfaces = getNetworkInterfaces();
  for (const iface of interfaces) {
    try {
      udpSocket.setMulticastInterface(iface.address);
      udpSocket.send(payload, 0, payload.length, UDP_PORT, MULTICAST_ADDR, (err) => {
        if (err) {
          // Ignore individual interface send errors (e.g., if link is down)
        }
      });
    } catch (e) {
      // Fail silently for virtual/inactive interfaces
    }
  }
}

// Active TCP Subnet Scanner
async function scanSubnets() {
  log('info', 'Starting TCP subnet scanning...');
  const interfaces = getNetworkInterfaces();
  
  const scanPromises = [];
  const scannedIps = new Set();

  for (const iface of interfaces) {
    const ips = getSubnetIps(iface.address, iface.netmask);
    log('info', `Scanning interface ${iface.name} (${iface.address}) - ${ips.length} IPs...`);
    ips.forEach(ip => scannedIps.add(ip));
  }

  const ipList = Array.from(scannedIps);
  
  // Implement a batch scanner to prevent socket exhaustion
  const concurrencyLimit = 40;
  for (let i = 0; i < ipList.length; i += concurrencyLimit) {
    const batch = ipList.slice(i, i + concurrencyLimit);
    const batchPromises = batch.map(ip => checkPeerRegistration(ip));
    await Promise.all(batchPromises);
  }
  
  log('success', 'Subnet scanning completed.');
}

function checkPeerRegistration(ip) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      alias: device.alias,
      version: '2.0',
      deviceModel: device.deviceModel,
      deviceType: device.deviceType,
      fingerprint: device.id,
      port: device.port,
      protocol: 'http',
      download: false
    });

    const req = http.request({
      hostname: ip,
      port: 53317, // default LocalSend port
      path: '/api/localsend/v2/register',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 800
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const info = JSON.parse(data);
            upsertDevice({ ...info, ip });
            log('success', `Discovered peer via scan: ${info.alias} at ${ip}`);
          } catch (e) {
            // Ignore JSON parsing errors
          }
        }
        resolve();
      });
    });

    req.on('error', () => {
      resolve(); // ignore connection errors
    });

    req.on('timeout', () => {
      req.destroy();
      resolve();
    });

    req.write(payload);
    req.end();
  });
}

function startLanRuntime() {
  device.ip = getLanIp();
  device.status = 'online';
  device.lastSeen = Date.now();
  devices.set(device.id, device);

  startHttpServer().then(() => {
    startUdpDiscovery();
    
    // Broadcast announcement immediately and then periodically
    sendUdpAnnouncement();
    announceTimer = setInterval(sendUdpAnnouncement, 8000);

    // Initial subnet scan
    scanSubnets();
    scanTimer = setInterval(scanSubnets, 40000); // scan subnets every 40s
  });

  // Cleanup offline devices timer
  cleanupTimer = setInterval(() => {
    let changed = false;
    for (const [id, d] of devices.entries()) {
      if (id === device.id) continue;
      if (Date.now() - d.lastSeen > 16000 && d.status === 'online') {
        d.status = 'offline';
        changed = true;
        log('warning', `Device went offline: ${d.alias}`);
      }
    }
    if (changed) emitDevices();
  }, 3000);
}

function shutdownRuntime() {
  clearInterval(announceTimer);
  clearInterval(scanTimer);
  clearInterval(cleanupTimer);

  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }

  if (udpSocket) {
    udpSocket.close();
    udpSocket = null;
  }
}

// IPC Handlers
ipcMain.handle('app:get-info', () => ({
  id: device.id,
  name: device.alias,
  ip: getLanIp(),
  role: 'Peer',
  port: device.port
}));

ipcMain.handle('app:get-interfaces', () => getNetworkInterfaces());

ipcMain.handle('app:set-active-ip', (_event, ip) => {
  userSelectedIp = ip;
  device.ip = getLanIp();
  upsertDevice(device);
  sendUdpAnnouncement();
  log('info', `Active IP configured: ${device.ip}`);
  return device.ip;
});

ipcMain.handle('dialog:pick-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const stat = fs.statSync(filePath);
  return { path: filePath, name: path.basename(filePath), size: stat.size };
});

// IPC Accept/Decline transfer invites
ipcMain.handle('lan:accept-invite', (_event, sessionId) => {
  const session = pendingIncomingSessions.get(sessionId);
  if (!session) return { ok: false, error: 'Session not found' };

  session.res.writeHead(200, { 'Content-Type': 'application/json' });
  session.res.end(JSON.stringify({
    sessionId: session.sessionId,
    files: session.fileTokens
  }));

  log('info', `Accepted transfer session ${sessionId}`);
  return { ok: true };
});

ipcMain.handle('lan:decline-invite', (_event, sessionId) => {
  const session = pendingIncomingSessions.get(sessionId);
  if (!session) return { ok: false, error: 'Session not found' };

  session.res.writeHead(403);
  session.res.end('Declined by receiver');

  pendingIncomingSessions.delete(sessionId);
  if (activeIncomingSession?.sessionId === sessionId) {
    activeIncomingSession = null;
  }

  log('info', `Declined transfer session ${sessionId}`);
  return { ok: true };
});

ipcMain.handle('lan:rescan', async () => {
  sendUdpAnnouncement();
  await scanSubnets();
  return { ok: true };
});

// Send file (REST based)
ipcMain.handle('file:send', async (_event, payload) => {
  const { path: filePath, targets } = payload;
  if (!targets || !targets[0]) throw new Error('No targets selected');
  const targetId = targets[0];
  const peer = devices.get(targetId);
  if (!peer) throw new Error('Peer not found or offline');

  const stat = fs.statSync(filePath);
  const fileName = path.basename(filePath);
  const fileId = crypto.randomBytes(8).toString('hex');

  log('info', `Initiating transfer of ${fileName} to ${peer.alias}...`);

  // Step 1: Prepare upload
  const preparePayload = JSON.stringify({
    info: {
      alias: device.alias,
      version: '2.0',
      deviceModel: device.deviceModel,
      deviceType: device.deviceType,
      fingerprint: device.id,
      port: device.port,
      protocol: 'http',
      download: false
    },
    files: {
      [fileId]: {
        id: fileId,
        fileName,
        size: stat.size,
        fileType: 'application/octet-stream'
      }
    }
  });

  const prepareRes = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: peer.ip,
      port: peer.port,
      path: '/api/localsend/v2/prepare-upload',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(preparePayload)
      },
      timeout: 15000 // give the receiver time to accept
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid response from peer'));
          }
        } else if (res.statusCode === 403) {
          reject(new Error('Transfer declined by peer'));
        } else if (res.statusCode === 409) {
          reject(new Error('Peer is busy with another transfer'));
        } else {
          reject(new Error(`Peer rejected with code ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.write(preparePayload);
    req.end();
  });

  const { sessionId, files: fileTokens } = prepareRes;
  const token = fileTokens[fileId];
  if (!token) throw new Error('Receiver did not authorize the file upload');

  log('info', `File transfer approved. Starting binary upload...`);

  // Step 2: Upload file
  return new Promise((resolve, reject) => {
    const uploadUrl = `/api/localsend/v2/upload?sessionId=${sessionId}&fileId=${fileId}&token=${token}`;
    const fileStream = fs.createReadStream(filePath);
    
    const req = http.request({
      hostname: peer.ip,
      port: peer.port,
      path: uploadUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size
      }
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode === 200) {
          log('success', `File ${fileName} sent successfully`);
          sendToRenderer('file:progress', {
            transferId: sessionId,
            receiverId: targetId,
            senderId: device.id,
            name: fileName,
            size: stat.size,
            progress: 100,
            speedMbps: 0,
            avgSpeedMbps: 0,
            status: 'completed'
          });
          resolve({ ok: true });
        } else {
          reject(new Error(`Upload failed with code ${res.statusCode}`));
        }
      });
    });

    req.on('error', (err) => {
      fileStream.destroy();
      reject(err);
    });

    let uploadedBytes = 0;
    const startedAt = Date.now();
    let lastReportedAt = Date.now();

    fileStream.on('data', (chunk) => {
      uploadedBytes += chunk.length;
      
      const now = Date.now();
      if (now - lastReportedAt >= 150) {
        lastReportedAt = now;
        const elapsed = (now - startedAt) / 1000 || 0.001;
        const speedMbps = (uploadedBytes * 8) / elapsed / 1000000;
        sendToRenderer('file:progress', {
          transferId: sessionId,
          receiverId: targetId,
          senderId: device.id,
          name: fileName,
          size: stat.size,
          progress: (uploadedBytes / stat.size) * 100,
          speedMbps,
          avgSpeedMbps: speedMbps,
          status: 'sending'
        });
      }
    });

    fileStream.on('end', () => {
      req.end();
    });

    fileStream.pipe(req);
  });
});

// Send quick text message
ipcMain.handle('chat:send', async (_event, payload) => {
  const { text, targets } = payload;
  if (!targets || !targets[0]) throw new Error('No targets selected');
  const targetId = targets[0];
  const peer = devices.get(targetId);
  if (!peer) throw new Error('Peer not found or offline');

  const textBytes = Buffer.from(text, 'utf8');
  const fileId = crypto.randomBytes(8).toString('hex');
  const fileName = 'text.txt';

  log('info', `Sending text message to ${peer.alias}...`);

  // Step 1: Prepare upload
  const preparePayload = JSON.stringify({
    info: {
      alias: device.alias,
      version: '2.0',
      deviceModel: device.deviceModel,
      deviceType: device.deviceType,
      fingerprint: device.id,
      port: device.port,
      protocol: 'http',
      download: false
    },
    files: {
      [fileId]: {
        id: fileId,
        fileName,
        size: textBytes.length,
        fileType: 'text/plain'
      }
    }
  });

  const prepareRes = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: peer.ip,
      port: peer.port,
      path: '/api/localsend/v2/prepare-upload',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(preparePayload)
      },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid response'));
          }
        } else if (res.statusCode === 403) {
          reject(new Error('Message declined by peer'));
        } else {
          reject(new Error(`Rejected with status ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(preparePayload);
    req.end();
  });

  const { sessionId, files: fileTokens } = prepareRes;
  const token = fileTokens[fileId];
  if (!token) throw new Error('Not authorized by peer');

  // Step 2: Upload raw text bytes
  return new Promise((resolve, reject) => {
    const uploadUrl = `/api/localsend/v2/upload?sessionId=${sessionId}&fileId=${fileId}&token=${token}`;
    const req = http.request({
      hostname: peer.ip,
      port: peer.port,
      path: uploadUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': textBytes.length
      }
    }, (res) => {
      res.on('end', () => {
        if (res.statusCode === 200) {
          // Render locally in chat history
          sendToRenderer('chat:message', {
            id: `${Date.now()}-${Math.random()}`,
            sender: { id: device.id, alias: device.alias },
            receiverId: targetId,
            text,
            time: Date.now()
          });
          resolve({ ok: true });
        } else {
          reject(new Error(`Failed to send message: ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(textBytes);
    req.end();
  });
});

// Stub WebRTC calls (since LocalSend is file-sharing only, we bypass signaling)
ipcMain.handle('webrtc:signal', () => ({ ok: true }));
ipcMain.handle('call:event', () => ({ ok: true }));
ipcMain.handle('lan:connect-peer', async (_event, ip) => {
  // Let the user add a peer manually by IP
  const peerIp = String(ip || '').trim();
  if (!isValidIpv4(peerIp)) throw new Error('Invalid IP Address');
  
  log('info', `Manually probing peer at ${peerIp}...`);
  await checkPeerRegistration(peerIp);
  return { ok: true, ip: peerIp };
});

function isValidIpv4(ip) {
  const parts = String(ip || '').trim().split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

// Window creation & management
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
