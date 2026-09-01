import { Server, Socket } from "socket.io";
import { randomUUID } from "crypto";
import { encode } from "@msgpack/msgpack";

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

const sessions = new Map<string, Session>();
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const GRACE_PERIOD = 60000;
const CLEANUP_INTERVAL = 60000;

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

export function initSocket(server: import("http").Server): Server {
  io = new Server(server, {
    cors: { origin: "*" },
    // Disable built-in heartbeat to use our custom one as requested
    pingInterval: HEARTBEAT_INTERVAL,
    pingTimeout: HEARTBEAT_TIMEOUT,
  });

  io.on("connection", (socket: Socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

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
          console.log(`📦 Msgpack enabled for session ${sessionId}`);
        }
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
      handleDisconnect(socket);
    });
  });

  // Cleanup routine
  setInterval(cleanupSessions, CLEANUP_INTERVAL);

  return io;
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
