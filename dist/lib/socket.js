import { Server } from "socket.io";
import { randomUUID } from "crypto";
const sessions = new Map();
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const GRACE_PERIOD = 60000;
const CLEANUP_INTERVAL = 60000;
let io = null;
/**
 * Broadcasts an event to all connected clients and queues it for those in grace period.
 */
export function broadcastToSessions(event, data) {
    if (!io)
        return;
    // Send to all currently connected sockets
    io.emit(event, data);
    // Queue for disconnected-pending sessions
    for (const session of sessions.values()) {
        if (session.status === "disconnected-pending") {
            session.messageQueue.push({ event, data });
        }
    }
}
export function initSocket(server) {
    io = new Server(server, {
        cors: { origin: "*" },
        // Disable built-in heartbeat to use our custom one as requested
        pingInterval: HEARTBEAT_INTERVAL,
        pingTimeout: HEARTBEAT_TIMEOUT,
    });
    io.on("connection", (socket) => {
        console.log(`🔌 Client connected: ${socket.id}`);
        // Assign or Resume Session
        socket.on("resume", (sessionId, callback) => {
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
                socket.sessionId = sessionId;
                // Send queued messages
                if (session.messageQueue.length > 0) {
                    console.log(`📨 Delivering ${session.messageQueue.length} queued messages to ${sessionId}`);
                    session.messageQueue.forEach((msg) => {
                        socket.emit(msg.event, msg.data);
                    });
                    session.messageQueue = [];
                }
                callback({ success: true, data: session.data });
            }
            else {
                console.log(`❌ Resume failed for session: ${sessionId}`);
                callback({ success: false });
            }
        });
        socket.on("identify", (callback) => {
            const sessionId = randomUUID();
            const session = {
                id: sessionId,
                socketId: socket.id,
                status: "connected",
                lastSeen: Date.now(),
                data: {},
                messageQueue: [],
            };
            sessions.set(sessionId, session);
            socket.sessionId = sessionId;
            console.log(`🆕 New session created: ${sessionId} for socket ${socket.id}`);
            callback({ sessionId });
        });
        // Heartbeat Implementation
        const heartbeatInterval = setInterval(() => {
            socket.emit("ping");
            const timeout = setTimeout(() => {
                console.warn(`⚠️ Heartbeat timeout for socket ${socket.id}`);
                socket.disconnect(true); // This will trigger the 'disconnect' event
            }, HEARTBEAT_TIMEOUT);
            socket.once("pong", () => {
                clearTimeout(timeout);
                const sessionId = socket.sessionId;
                if (sessionId) {
                    const session = sessions.get(sessionId);
                    if (session)
                        session.lastSeen = Date.now();
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
function handleDisconnect(socket) {
    const sessionId = socket.sessionId;
    if (!sessionId)
        return;
    const session = sessions.get(sessionId);
    if (session && session.status === "connected") {
        console.log(`⏳ Entering grace period for session: ${sessionId}`);
        session.status = "disconnected-pending";
        session.socketId = null;
        session.lastSeen = Date.now();
        session.disconnectTimer = setTimeout(() => {
            console.log(`🗑️ Grace period expired for session: ${sessionId}`);
            sessions.delete(sessionId);
        }, GRACE_PERIOD);
    }
}
function cleanupSessions() {
    const now = Date.now();
    for (const [sessionId, session] of sessions.entries()) {
        if (session.status === "disconnected-pending" &&
            now - session.lastSeen > GRACE_PERIOD) {
            console.log(`🧹 Cleaning up expired session: ${sessionId}`);
            sessions.delete(sessionId);
        }
    }
}
export function getIO() {
    if (!io)
        throw new Error("Socket.io not initialized");
    return io;
}
//# sourceMappingURL=socket.js.map