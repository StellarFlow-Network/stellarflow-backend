import { Server } from "socket.io";
import { logger } from "./logger";

let io: Server | null = null;

export function initSocket(server: import("http").Server): Server {
  io = new Server(server, {
    cors: { origin: "*" },
  });

  io.on("connection", (socket) => {
    logger.info(`🔌 Client connected: ${socket.id}`);
    socket.on("disconnect", () =>
      logger.info(`🔌 Client disconnected: ${socket.id}`)
    );
  });

  return io;
}

export function getIO(): Server {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}
