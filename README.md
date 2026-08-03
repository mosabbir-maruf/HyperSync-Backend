<p align="center">
  <img src="assets/logo.svg" width="120" alt="HyperSync Logo" />
</p>

# HyperSync Backend

The backend for HyperSync, built using Cloudflare Workers and Durable Objects. It serves as the signaling and presence server to connect peers for direct WebRTC file transfers.

## Architecture

This backend is serverless, running entirely on the Cloudflare global edge network. It utilizes:
- **Cloudflare Workers**: For edge computing and routing WebSocket requests.
- **Durable Objects (DO)**: To maintain state and manage WebSocket connections for individual rooms.
- **SQLite in DO**: Cloudflare's new SQLite integration in Durable Objects powers the data persistence for state without needing a separate database.

There are three main Durable Object classes:
1. `LobbyRoom`: Manages the global "Nearby Devices" presence list, broadcasting when devices join, leave, or become busy.
2. `SignalingRoom`: Manages 1-to-1 WebRTC signaling (offer/answer/ICE exchange) between two specific peers.
3. `GroupSignalingRoom`: Manages N-way WebRTC signaling for group sessions where multiple peers connect simultaneously.

## How It Works & Connects

1. **Routing**: When the frontend initiates a WebSocket connection (`wss://.../ws`), the Worker intercepts the request.
2. **DO Handoff**: The Worker parses the URL to determine the destination (Lobby, 1-to-1 Room, or Group Room) and forwards the WebSocket connection to the appropriate Durable Object instance.
3. **Message Broadcast**: The Durable Object receives WebSocket messages (JSON) from one peer and broadcasts them to the other connected peer(s) in that specific room. 
4. **No Middleman**: The backend never sees the actual files being transferred. It only passes the WebRTC signaling data (SDP offers/answers and ICE candidates) necessary to punch through NATs and establish the direct browser-to-browser `RTCDataChannel`.

## Environment Configuration

Configuration variables are managed in `wrangler.toml`:

```toml
[vars]
ENVIRONMENT = "production"
PROTOCOL_VERSION = 1
SESSION_TIMEOUT_MS = 900000
HEARTBEAT_INTERVAL_MS = 20000
RECONNECT_WINDOW_MS = 30000
MAX_MESSAGE_SIZE = 16384
SESSION_CODE_LENGTH = 6
```

## File Structure

```text
HyperSync-Backend/
├── src/
│   ├── index.ts                # Worker entry point and router
│   ├── config/                 # Environment variables and constants
│   ├── controllers/            # Request handlers
│   ├── durable/                # Durable Object definitions
│   │   ├── SignalingRoom.ts    # 1-to-1 WebRTC room
│   │   ├── LobbyRoom.ts        # Global presence lobby
│   │   └── GroupSignalingRoom.ts # N-way WebRTC group room
│   ├── middleware/             # Error handling and CORS
│   ├── protocol/               # Message schemas and validation
│   ├── routes/                 # Express-like routing setup
│   ├── services/               # State management logic inside DOs
│   ├── types/                  # TypeScript interfaces
│   ├── utils/                  # Helper functions
│   └── validation/             # Zod schemas for input validation
├── package.json                # Dependencies
├── tsconfig.json               # TypeScript configuration
└── wrangler.toml               # Cloudflare Worker configuration
```

## Deployment Guide (Cloudflare Workers)

1. Ensure you have the [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed globally or run it via npx.
2. Log in to your Cloudflare account from your terminal:
   ```bash
   npx wrangler login
   ```
3. Deploy the worker to your Cloudflare account:
   ```bash
   npm run deploy
   # or run directly:
   # npx wrangler deploy
   ```
4. Update the frontend's `.env` file with the newly generated `*.workers.dev` URL!
