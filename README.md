# LANLink

LANLink is a cross-platform Electron desktop app for communication between computers on the same LAN. It uses UDP broadcast for automatic host discovery, Socket.IO for realtime coordination, chunked LAN file transfer, Chart.js for transfer speed telemetry, and WebRTC for 1-to-1 voice/video calls.

## UI/UX Design Plan

LANLink is designed before implementation as a modern dark desktop dashboard for a school project demonstration. The interface keeps operational status visible at all times, avoids a default HTML look, and uses clear panel separation for LAN discovery, messaging, file transfer, charts, calls, and logs.

### 1. UI/UX Analysis

- Primary users: students demonstrating LAN communication on multiple computers.
- Main goal: quickly prove that devices discover each other automatically, then send messages, files, and start a 1-to-1 voice/video call.
- UX priorities: visible connection state, simple target selection, per-device transfer feedback, readable realtime logs, and stable 1366x768 / 1920x1080 layouts.

### 2. Overall App Layout

- Left sidebar: LAN device list and target selection.
- Top status bar: role, local IP, connection status, online device count, average RTT.
- Center workspace: text chat and file transfer.
- Right rail: transfer speed chart and voice/video call panel.
- Bottom panel: timestamped realtime event log.

### 3. Wireframe Description

```text
+-------------+--------------------------------------------------+
| Device list | Role | IP | Connection | Online | Average Ping  |
|             +-------------------------+------------------------+
| selectable  | Text chat               | Speed chart            |
| devices     |                         +------------------------+
|             | File transfer           | Voice/video call       |
|             +--------------------------------------------------+
|             | Realtime event log                                |
+-------------+--------------------------------------------------+
```

### 4. Design System

- Background: deep charcoal `#081018`.
- Panels: graphite `#101923`, `#13202c`, `#182737`.
- Borders: blue-gray `#1d2b38` / `#263747`.
- Primary accent: cyan `#22d3ee`.
- Secondary accent: violet `#8b5cf6`.
- Success/online: green `#35d07f`.
- Warning: amber `#f7b955`.
- Error/offline: red `#ff6577`.
- Radius: 9px for controls, 12-14px for cards and panels.
- Motion: 140-160ms hover, focus, progress, and selection transitions.

### 5. Component List

- App shell, sidebar, top status bar, panel header, device card, role chip, status dot, button, icon button, chat bubble, file picker, transfer item, progress bar, chart panel, video tile, call controls, log row.

### 6. Color Palette

- Background: `#081018`.
- Surface: `#101923`.
- Raised surface: `#13202c`.
- Input/card surface: `#182737`.
- Text: `#eef7ff`.
- Muted text: `#8ea2b4`.
- Accent: `#22d3ee`.
- Violet role accent: `#8b5cf6`.
- Green online/success: `#35d07f`.
- Amber warning: `#f7b955`.
- Red offline/error: `#ff6577`.

### 7. Typography

- Font stack: Inter-like system sans stack.
- App title: 21px, 800-900 weight.
- Panel title: 15px, 800 weight.
- Body/control text: 13-14px, 700-800 weight for controls.
- Labels: 11-12px uppercase, high weight, muted color.
- Logs: 12px monospace.

### 8. Spacing Rules

- Base spacing scale: 4px.
- App gutter: 10-14px.
- Panel padding: 14-16px.
- Component gaps: 10-14px.
- Device/transfer row padding: 9-12px.

### 9. Button States

- Primary: cyan gradient, dark text, subtle cyan shadow.
- Secondary: dark raised surface with border.
- Danger: red tinted surface and border.
- Hover: slight upward movement and stronger border contrast.
- Focus: cyan outline.
- Disabled: reduced opacity and no transform.

### 10. Online/Offline Status Styles

- Online: green dot with soft green halo, full opacity, selectable.
- Offline: red dot with soft red halo, muted opacity, not selectable.
- Scanning/warning: amber status text.
- Connected/success: green status text.

### 11. Card Components

- Cards use dark raised surfaces, 12px radius, subtle border, no nested-card visual clutter.
- Selected cards use cyan border and a soft cyan inset glow.
- Offline cards stay visible but are visually muted.

### 12. Device List Item Design

- Top row: green/red status dot, device name, host/client role chip.
- Middle rows: LAN IP and unique device ID.
- Bottom row: RTT and connected duration.
- Click selects or deselects online remote devices.

### 13. Chat Bubble Design

- Sent messages align right with cyan-tinted background.
- Received messages align left with neutral dark background.
- Metadata shows sender, receiver target list, and timestamp.
- Message content is escaped before rendering.

### 14. File Transfer Item Design

- Header: file name and status chip.
- Body: progress track with cyan-to-green fill.
- Footer: receiver name, percentage, current Mbps, and average Mbps.

### 15. Progress Bar Design

- Track: dark blue-gray.
- Fill: cyan-to-green gradient.
- Updates smoothly without changing row height.
- Each receiver gets its own progress row.

### 16. Realtime Log Panel Design

- Scrollable bottom panel with newest item first.
- Monospace timestamp.
- Type label uses semantic color: info, success, warning, error.
- Keeps the latest 160 log rows.

### 17. Video/Voice Call Panel Design

- Remote stream is the main tile.
- Local preview sits as an overlay in the lower-right corner.
- Controls include Start, End, microphone toggle, and webcam toggle.
- Call status dot switches between idle/offline and active/online.

### 18. Chart Panel Design

- Chart.js line chart integrated into the right rail.
- X-axis: time.
- Y-axis: Mbps.
- Cyan line, translucent fill, dark grid lines, no bulky legend.
- Updates every second from active transfer telemetry.

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

## Test With Two Computers

1. Connect both computers to the same Wi-Fi or Ethernet LAN.
2. Run `npm start` on both computers.
3. On each app, choose the correct local LAN IP from the `Local IP` dropdown if the computer has multiple adapters.
4. On one computer, enter the other computer's LAN IP in `Peer IP`, then click `Connect`.
5. Wait until the peer appears online in `Paired Devices`. The app auto-selects the single online peer.
6. Send a text message.
7. Pick a file and send it. Progress and Mbps should update per transfer.
8. Select the online peer and click `Start call` to test voice/video.
9. If the connection looks stale after changing Wi-Fi/Ethernet, click `Reload`, then enter the peer IP and click `Connect` again.

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
- For the most stable demo, use only two computers and connect by `Peer IP`.
- If a device does not appear after changing Wi-Fi/Ethernet, click `Reload`, then connect to the peer IP again.
- If webcam or microphone does not work, check OS privacy permissions for Electron/Terminal.
- If WebRTC video does not connect, test text chat first. WebRTC signaling uses the Socket.IO host, so chat must work before calls can work.

## Notes

- The app is optimized for one stable two-device pair.
- Ping RTT updates every 3 seconds and is smoothed to avoid flickering.
- File speed uses `Mbps = transferred bits / elapsed time / 1,000,000`.
- WebRTC is implemented for stable 1-to-1 calls first.
- The app prioritizes reliability and demonstration clarity over complex production networking edge cases.
