import { Server, Socket } from "socket.io";
import { randomUUID } from "crypto";
import { encode } from "@msgpack/msgpack";
import { getApiContentSecurityPolicy } from "../middleware/securityHeadersMiddleware";
import {
  claimSessionConnectionForToken,
  unregisterSessionConnection,
} from "./sessionConnectionRegistry";

interface Session {
  id: string; // connectionSessionId
  socketId: string | null;
  status: "connected" | "disconnected-pending";
  lastSeen: number;
  data: any; // Store any session data here
  disconnectTimer?: NodeJS.Timeout;
  messageQueue: { event: string; data: any; useMsgpack?: boolean }[]; // Queue for missed messages
  msgpackEnabled?: boolean; // Indicates if this session prefers MessagePack
}

interface MarketSubscription {
  pairs: Set<string>;
  msgpackEnabled: boolean;
  lastUpdate: number;
}

interface MarketEvent {
  type: "price" | "volume" | "orderbook";
  pair: string;
  data: any;
  timestamp: number;
}

const sessions = new Map<string, Session>();
const marketSubscriptions = new Map<string, MarketSubscription>(); // socketId -> subscription
const pairSubscribers = new Map<string, Set<string>>(); // pair -> set of socketIds
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const GRACE_PERIOD = 60000;
const CLEANUP_INTERVAL = 60000;
const MAX_PAIRS_PER_SOCKET = 50;

let io: Server | null = null;

/**
 * Broadcasts an event to all connected clients and queues it for those in grace period.
 */
export function broadcastToSessions(event: string, data: any) {
  if (!io) return;

  // Send to all currently connected sockets individually to respect msgpack settings
  for (const session of sessions.values()) {
    if (session.status === "connected" && session.socketId) {
      const socket = io.sockets.sockets.get(session.socketId);
      if (socket) {
        if (session.msgpackEnabled) {
          socket.emit(event, encode(data));
        } else {
          socket.emit(event, data);
        }
      }
    } else if (session.status === "disconnected-pending") {
      session.messageQueue.push({ event, data, useMsgpack: session.msgpackEnabled });
    }
  }
}

/**
 * Publishes a market event to all subscribed sockets for the given pair.
 * Multiplexes price, volume, and order book updates into a single stream.
 */
export function publishMarketEvent(event: MarketEvent) {
  if (!io) return;

  const subscribers = pairSubscribers.get(event.pair);
  if (!subscribers || subscribers.size === 0) return;

  const payload = {
    type: event.type,
    pair: event.pair,
    data: event.data,
    timestamp: event.timestamp || Date.now(),
  };

  for (const socketId of subscribers) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;

    const sub = marketSubscriptions.get(socketId);
    if (!sub) continue;

    sub.lastUpdate = Date.now();

    if (sub.msgpackEnabled) {
      socket.emit("market", encode(payload));
    } else {
      socket.emit("market", payload);
    }
  }
}

/**
 * Returns memory overhead estimate for active client connections.
 * Used to validate support for 10,000 active sockets.
 */
export function getConnectionMemoryStats() {
  const memory = process.memoryUsage();
  const activeSockets = io ? io.sockets.size : 0;
  const activeSessions = sessions.size;
  const activeSubscriptions = marketSubscriptions.size;
  const heapUsed = memory.heapUsed;
  const rss = memory.rss;

  return {
    activeSockets,
    activeSessions,
    activeSubscriptions,
    heapUsed,
    rss,
    estimatedBytesPerSocket:
      activeSockets > 0 ? Math.round((heapUsed - (global as any).__baselineHeap ?? heapUsed)) / activeSockets) : 0,
    supports10k: activeSockets === 0 || heapUsed / activeSockets < 50 * 1024,
  };
}

function normalizePair(pair: string): string | null {
  if (typeof pair !== "string") return null;
  const trimmed = pair.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,15}-[A-Z0-9]{1,15}$/.test(trimmed)) return null;
  return trimmed;
}

function parsePairs(pairs: unknown): string[] | null {
  if (pairs == null) return null;
  const list = Array.isArray(pairs) ? pairs : String(pairs).split(",");
  if (list.length === 0 || list.length > MAX_PAIRS_PER_SOCKET) return null;
  const normalized: string[] = [];
  for (const raw of list) {
    const pair = normalizePair(raw as string);
    if (!pair) return null;
    if (!normalized.includes(pair)) normalized.push(pair);
  }
  return normalized.length > 0 ? normalized : null;
}

function addSubscription(socketId: string, pairs: string[], msgpackEnabled: boolean) {
  const existing = marketSubscriptions.get(socketId);
  if (existing) {
    for (const pair of pairs) {
      if (!existing.pairs.has(pair)) {
        existing.pairs.add(pair);
        let set = pairSubscribers.get(pair);
        if (!set) {
          set = new Set();
          pairSubscribers.set(pair, set);
        }
        set.add(socketId);
      }
    }
    existing.msgpackEnabled = msgpackEnabled;
    existing.lastUpdate = Date.now();
    return;
  }

  const pairSet = new Set(pairs);
  marketSubscriptions.set(socketId, {
    pairs: pairSet,
    msgpackEnabled,
    lastUpdate: Date.now(),
  });

  for (const pair of pairSet) {
    let set = pairSubscribers.get(pair);
    if (!set) {
      set = new Set();
      pairSubscribers.set(pair, set);
    }
    set.add(socketId);
  }
}

function removeSubscription(socketId: string) {
  const sub = marketSubscriptions.get(socketId);
  if (!sub) return;
  for (const pair of sub.pairs) {
    const set = pairSubscribers.get(pair);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) pairSubscribers.delete(pair);
    }
  }
  marketSubscriptions.delete(socketId);
}

export function initSocket(server: import("http").Server): Server {
  if (!(global as any).__baselineHeap) {
    (global as any).__baselineHeap = process.memoryUsage().heapUsed;
  }

  io = new Server(server, {
    cors: { origin: "*" },
    // Disable built-in heartbeat to use our custom one as requested
    pingInterval: HEARTBEAT_INTERVAL,
    pingTimeout: HEARTBEAT_TIMEOUT,
    // Reduce per-connection memory overhead for high concurrency
    perMessageDeflate: false,
    maxHttpBufferSize: 1e6,
    transports: ["websocket", "polling"],
  });

  io.engine.on("initial_headers", (headers) => {
    headers["content-security-policy"] = getApiContentSecurityPolicy();
    headers["x-frame-options"] = "DENY";
    headers["x-content-type-options"] = "nosniff";
  });

  io.on("connection", (socket: Socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Claim the authenticated user session (Issue #1054) so the stale session
    // purge worker never removes a session that still owns a live connection.
    let authSessionId: string | null = null;
    const handshakeToken = readHandshakeToken(socket);
    if (handshakeToken) {
      void claimSessionConnectionForToken(handshakeToken).then((sid) => {
        if (sid && socket.connected) {
          authSessionId = sid;
        }
      });
    }

    // Assign or Resume Session
    socket.on(
      "resume",
      (
        sessionId: string,
        callback: (response: { success: boolean; data?: any }) => void,
      ) => {
        const session = sessions.get(sessionId);
        if (session && session.status === "disconnected-pending") {
          console.log(`🔄 Session resumed: ${sessionId}`);

          if (session.disconnectTimer) {
            clearTimeout(session.disconnectTimer);
            delete session.disconnectTimer;
          }

          session.socketId = socket.id;
          session.status = "connected";
          session.lastSeen = Date.now();
          (socket as any).sessionId = sessionId;

          // Send queued messages
          if (session.messageQueue.length > 0) {
            console.log(
              `📨 Delivering ${session.messageQueue.length} queued messages to ${sessionId}`,
            );
            session.messageQueue.forEach((msg) => {
              if (msg.useMsgpack) {
                socket.emit(msg.event, encode(msg.data));
              } else {
                socket.emit(msg.event, msg.data);
              }
            });
            session.messageQueue = [];
          }

          callback({ success: true, data: session.data });
        } else {
          console.log(`❌ Resume failed for session: ${sessionId}`);
          callback({ success: false });
        }
      },
    );

    socket.on("enable_msgpack", () => {
      const sessionId = (socket as any).sessionId;
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          session.msgpackEnabled = true;
          console.log(`🖦 Msgpack enabled for session ${sessionId}`);
        }
      }
      const sub = marketSubscriptions.get(socket.id);
      if (sub) {
        sub.msgpackEnabled = true;
      }
    });

    socket.on(
      "identify",
      (callback: (response: { sessionId: string }) => void) => {
        const sessionId = randomUUID();
        const session: Session = {
          id: sessionId,
          socketId: socket.id,
          status: "connected",
          lastSeen: Date.now(),
          data: {},
          messageQueue: [],
        };
        sessions.set(sessionId, session);
        (socket as any).sessionId = sessionId;
        console.log(
          `🆕 New session created: ${sessionId} for socket ${socket.id}`,
        );
        callback({ sessionId });
      },
    );

    // Market stream subscription (combined price + volume + order book)
    const handleSubscribe = (
      payload: unknown,
      callback?: (response: {
        success: boolean;
        pairs?: string[];
        error?: string;
      }) => void,
    ) => {
      const pairsInput =
        typeof payload === "object" && payload !== null && "pairs" in (payload as any)
          ? (payload as any).pairs
          : payload;
      const pairs = parsePairs(pairsInput);
      if (!pairs) {
        const error = "invalid_pairs";
        if (callback) callback({ success: false, error: error });
        else socket.emit("subscribe_error", { error: error });
        return;
      }

      const sessionId = (socket as any).sessionId as string | undefined;
      const msgpackEnabled = sessionId
        ? sessions.get(sessionId)?.msgpackEnabled ?? false
        : false;

      addSubscription(socket.id, pairs, msgpackEnabled);
      console.log(
        `📄 Socket ${socket.id} subscribed to [${pairs.join(", ")}]`,
      );

      if (callback) callback({ success: true, pairs });
      else socket.emit("subscribed_ok", { pairs });
    };

    socket.on("subscribe", handleSubscribe);
    socket.on("subscribe_market", handleSubscribe);

    socket.on("unsubscribe", (payload: unknown) => {
      const pairsInput =
        typeof payload === "object" && payload !== null && "pairs" in (payload as any)
          ? (payload as any).pairs
          : payload;
      const pairs = parsePairs(pairsInput);
      if (!pairs) {
        socket.emit("unsubscribe_error", { error: "invalid_pairs" });
        return;
      }
      const sub = marketSubscriptions.get(socket.id);
      if (!sub) return;
      for (const pair of pairs) {
        if (sub.pairs.delete(pair)) {
          const set = pairSubscribers.get(pair);
          if (set) {
            set.delete(socket.id);
            if (set.size === 0) pairSubscribers.delete(pair);
          }
        }
      }
      socket.emit("subscribed_ok", { pairs: Array.from(sub.pairs) });
    });

    // Memory overhead inspection for 10,000 socket validation
    socket.on(
      "memory_stats",
      (callback?: (response: any) => void) => {
        const stats = getConnectionMemoryStats();
        if (callback) callback(stats);
        else socket.emit("memory_stats", stats);
      },
    );

    // Heartbeat Implementation
    const heartbeatInterval = setInterval(() => {
      socket.emit("ping");

      const timeout = setTimeout(() => {
        console.warn(`⚠️ Heartbeat timeout for socket ${socket.id}`);
        socket.disconnect(true); // This will trigger the 'disconnect' event
      }, HEARTBEAT_TIMEOUT);

      socket.once("pong", () => {
        clearTimeout(timeout);
        const sessionId = (socket as any).sessionId;
        if (sessionId) {
          const session = sessions.get(sessionId);
          if (session) session.lastSeen = Date.now();
        }
      });
    }, HEARTBEAT_INTERVAL);

    socket.on("disconnect", (reason) => {
      console.log(`🔌 Client disconnected (${reason}): ${socket.id}`);
      clearInterval(heartbeatInterval);
      removeSubscription(socket.id);
      handleDisconnect(socket);
    });
  });

  // Cleanup routine
  setInterval(cleanupSessions, CLEANUP_INTERVAL);

  // Register governance WebSocket handlers
  registerGovernanceHandlers(io);

  return io;
}

/**
 * Read the raw session token carried by a socket handshake, if any.
 */
function readHandshakeToken(socket: Socket): string | null {
  const token = socket.handshake.auth?.token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

function handleDisconnect(socket: Socket) {
  const sessionId = (socket as any).sessionId;
  if (!sessionId) return;

  const session = sessions.get(sessionId);
  if (session) {
    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
    }
    sessions.delete(sessionId);
    console.log(`🗑️ Session force-cleared on disconnect: ${sessionId}`);
  }
}

function cleanupSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (
      session.status === "disconnected-pending" &&
      now - session.lastSeen > GRACE_PERIOD
    ) {
      console.log(`🧹 Cleaning up expired session: ${sessionId}`);
      sessions.delete(sessionId);
    }
  }
}

export function getIO(): Server {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}
