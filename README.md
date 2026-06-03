# LANLink

LANLink is a cross-platform Electron desktop app for communication between computers on the same LAN. It uses UDP broadcast for automatic host discovery, Socket.IO for realtime coordination, chunked LAN file transfer, Chart.js for transfer speed telemetry, and WebRTC for 1-to-1 voice/video calls.

## UI/UX Design Plan

LANLink is designed as a modern dark desktop dashboard for a school project demonstration. The interface keeps operational status visible at all times and separates the app into stable work zones:

- Left sidebar: LAN device discovery and target selection.
- Top status bar: current role, LAN IP, connection state, online devices, and average RTT.
- Center workspace: text chat and file transfer.
- Right rail: transfer speed chart and voice/video call panel.
- Bottom panel: timestamped realtime event log.

### Design System

- Background: deep charcoal `#081018`.
- Panels: graphite `#101923` and `#13202c`.
- Borders: blue-gray `#1d2b38` / `#263747`.
- Primary accent: cyan `#22d3ee`.
- Secondary accent: violet `#8b5cf6`.
- Success/online: green `#35d07f`.
- Warning: amber `#f7b955`.
- Error/offline: red `#ff6577`.
- Typography: Inter-like system sans stack.
- Spacing: 4px base scale, 10-16px panel padding, 10-14px component gaps.
- Radius: 9px for controls, 12-14px for cards and panels.

### Component Behavior

- Buttons: clear primary, secondary, danger, disabled, hover, focus, and active states.
- Online devices: green dot, full opacity, selectable card.
- Offline devices: red dot, muted card, not selectable.
- Device rows: name, IP address, role chip, RTT, connected duration, unique ID.
- Chat bubbles: right aligned for sent messages, left aligned for received messages, with sender, receiver, and timestamp metadata.
- File transfer rows: file name, receiver, status chip, progress bar, percentage, and Mbps.
- Progress bars: cyan-to-green fill with smooth width updates.
- Logs: monospace timestamp rows with info/success/warning/error color labels.
- Call panel: remote video tile, local preview overlay, start/end/mic/camera controls.
- Chart panel: Chart.js line chart with time on X-axis and Mbps on Y-axis.

## Architecture

```text
src/main.js
  Electron main process
  UDP host discovery
  Host election
  Socket.IO server when host
  Socket.IO client for every app instance
  Ping RTT loop
  Message relay
  Chunked file transfer relay and receive-to-Downloads
  WebRTC signaling relay

src/preload.js
  Secure IPC bridge between renderer and Electron main

src/renderer/
  index.html
  styles.css
  renderer.js
  Dashboard UI, target selection, chat, transfer progress,
  Chart.js speed chart, WebRTC media controls, event log
```

## Folder Structure

```text
LANLink/
  package.json
  README.md
  src/
    main.js
    preload.js
    renderer/
      index.html
      styles.css
      renderer.js
```

## Install

Install dependencies while you have Internet access:

```bash
npm install
```

After dependencies are installed, the LAN demo does not require Internet access.

## Run

```bash
npm start
```

Run the same command on each computer in the same LAN.

## Test With Multiple Computers

1. Connect all computers to the same Wi-Fi or Ethernet LAN.
2. Run `npm start` on the first computer.
3. Wait a few seconds. If no host is found, the first app becomes Host.
4. Run `npm start` on other computers.
5. Clients should discover the host automatically and connect without typing an IP address.
6. Select one or more online devices from the left sidebar.
7. Send a text message.
8. Pick a file and send it. Progress and Mbps should update per transfer.
9. Select one online device and click `Start call` to test voice/video.

Received files are saved to:

```text
Downloads/LANLinkReceived/
```

## Firewall and LAN Troubleshooting

- Allow Node.js or Electron through the firewall on every computer.
- Make sure all computers are on the same subnet, for example `192.168.1.x`.
- Disable VPNs during the demo if they change routing or block LAN broadcast.
- Use a private/home network profile on Windows, not a public network profile.
- Confirm these ports are not blocked:
  - UDP `41234` for LAN host discovery.
  - TCP `32150` for Socket.IO communication.
- If two computers both become host, close clients, start one host first, wait 3 seconds, then start the other apps.
- If webcam or microphone does not work, check OS privacy permissions for Electron/Terminal.
- If WebRTC video does not connect, test text chat first. WebRTC signaling uses the Socket.IO host, so chat must work before calls can work.

## Notes

- The host manages the device list and broadcasts updates to clients.
- Ping RTT updates every second.
- File speed uses `Mbps = transferred bits / elapsed time / 1,000,000`.
- WebRTC is implemented for stable 1-to-1 calls first.
- The app prioritizes reliability and demonstration clarity over complex production networking edge cases.
