import { Server } from "socket.io";
/**
 * Broadcasts an event to all connected clients and queues it for those in grace period.
 */
export declare function broadcastToSessions(event: string, data: any): void;
export declare function initSocket(server: import("http").Server): Server;
export declare function getIO(): Server;
//# sourceMappingURL=socket.d.ts.map