/**
 * Governance WebSocket Service
 *
 * Provides real-time messaging and event notifications for governance proposals.
 * 
 * Features:
 * - Proposal-specific WebSocket channels: /governance/{proposal_id}
 * - Broadcasts: new comments, vote threshold updates, timelock status changes
 * - XSS sanitization for chat message payloads
 * - Sub-200ms broadcast latency
 */

import { Server, Socket } from "socket.io";
import { logger } from "../utils/logger";
import { getIO } from "../lib/socket";

// ─── Types ────────────────────────────────────────────────────────────────

interface GovernanceMessage {
  type: "comment" | "vote_update" | "timelock_status";
  proposalId: string;
  data: CommentEvent | VoteUpdateEvent | TimelockStatusEvent;
  timestamp: number;
}

interface CommentEvent {
  commentId: string;
  userId: string;
  content: string;
  createdAt: string;
}

interface VoteUpdateEvent {
  proposalId: string;
  forVotes: string;
  againstVotes: string;
  abstainVotes: string;
  totalVotes: string;
  thresholdMet: boolean;
}

interface TimelockStatusEvent {
  proposalId: string;
  status: "Queued" | "Executed" | "Expired";
  expiresAt?: string;
  executedAt?: string;
}

interface ProposalRoom {
  proposalId: string;
  clients: Set<string>;
}

// ─── XSS Sanitization ─────────────────────────────────────────────────────

/**
 * Sanitizes chat message content to prevent XSS attacks.
 * Removes dangerous HTML tags and scripts while preserving safe text.
 */
export function sanitizeChatMessage(content: string): string {
  if (typeof content !== "string") {
    return "";
  }

  // Remove script tags and their content
  let sanitized = content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");

  // Remove other dangerous HTML tags
  const dangerousTags = [
    /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
    /<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi,
    /<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi,
    /<link\b[^>]*>/gi,
    /<meta\b[^>]*>/gi,
    /<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi,
  ];

  dangerousTags.forEach((regex) => {
    sanitized = sanitized.replace(regex, "");
  });

  // Remove on* event handlers (onclick, onerror, etc.)
  sanitized = sanitized.replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, "");
  sanitized = sanitized.replace(/\s*on\w+\s*=\s*[^"'>\s]*/gi, "");

  // Remove javascript: protocol
  sanitized = sanitized.replace(/javascript:/gi, "");

  // Remove data: URIs that could execute scripts (except safe images)
  sanitized = sanitized.replace(/data:(?!image\/(png|jpeg|gif|webp))/gi, "");

  // Remove DOM-based XSS patterns
  sanitized = sanitized.replace(/document\./gi, "");
  sanitized = sanitized.replace(/window\./gi, "");
  sanitized = sanitized.replace(/eval\(/gi, "");

  // Strip remaining HTML tags but keep text content
  sanitized = sanitized.replace(/<[^>]*>/g, "");

  // Decode HTML entities to prevent double-encoding attacks
  sanitized = sanitized
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Trim whitespace
  sanitized = sanitized.trim();

  // Limit length to prevent abuse
  const MAX_LENGTH = 5000;
  if (sanitized.length > MAX_LENGTH) {
    sanitized = sanitized.substring(0, MAX_LENGTH);
  }

  return sanitized;
}

// ─── Room Management ───────────────────────────────────────────────────────

const proposalRooms = new Map<string, ProposalRoom>();

/**
 * Gets or creates a room for a specific proposal.
 */
function getProposalRoom(proposalId: string): ProposalRoom {
  let room = proposalRooms.get(proposalId);
  if (!room) {
    room = {
      proposalId,
      clients: new Set(),
    };
    proposalRooms.set(proposalId, room);
  }
  return room;
}

/**
 * Adds a client to a proposal room.
 */
export function joinProposalRoom(socket: Socket, proposalId: string): void {
  const room = getProposalRoom(proposalId);
  room.clients.add(socket.id);
  socket.join(`governance:${proposalId}`);
  
  logger.info(`[GovernanceWebSocket] Socket ${socket.id} joined proposal room: ${proposalId}`);
}

/**
 * Removes a client from a proposal room.
 */
export function leaveProposalRoom(socket: Socket, proposalId: string): void {
  const room = proposalRooms.get(proposalId);
  if (room) {
    room.clients.delete(socket.id);
    socket.leave(`governance:${proposalId}`);
    
    // Clean up empty rooms
    if (room.clients.size === 0) {
      proposalRooms.delete(proposalId);
      logger.info(`[GovernanceWebSocket] Removed empty proposal room: ${proposalId}`);
    }
    
    logger.info(`[GovernanceWebSocket] Socket ${socket.id} left proposal room: ${proposalId}`);
  }
}

/**
 * Removes a client from all proposal rooms.
 */
export function leaveAllProposalRooms(socket: Socket): void {
  for (const [proposalId, room] of proposalRooms.entries()) {
    if (room.clients.has(socket.id)) {
      leaveProposalRoom(socket, proposalId);
    }
  }
}

// ─── Event Broadcasting ─────────────────────────────────────────────────────

/**
 * Broadcasts a new comment event to all clients in a proposal room.
 * Target latency: < 200ms
 */
export function broadcastComment(proposalId: string, comment: CommentEvent): void {
  const startTime = Date.now();
  
  try {
    const io = getIO();
    const message: GovernanceMessage = {
      type: "comment",
      proposalId,
      data: comment,
      timestamp: startTime,
    };

    io.to(`governance:${proposalId}`).emit("governance_event", message);
    
    const latency = Date.now() - startTime;
    logger.info(`[GovernanceWebSocket] Comment broadcast for ${proposalId} (${latency}ms)`);
    
    if (latency > 200) {
      logger.warn(`[GovernanceWebSocket] Comment broadcast exceeded 200ms threshold: ${latency}ms`);
    }
  } catch (error) {
    logger.error(`[GovernanceWebSocket] Failed to broadcast comment for ${proposalId}:`, error);
  }
}

/**
 * Broadcasts a vote threshold update to all clients in a proposal room.
 * Target latency: < 200ms
 */
export function broadcastVoteUpdate(proposalId: string, voteData: VoteUpdateEvent): void {
  const startTime = Date.now();
  
  try {
    const io = getIO();
    const message: GovernanceMessage = {
      type: "vote_update",
      proposalId,
      data: voteData,
      timestamp: startTime,
    };

    io.to(`governance:${proposalId}`).emit("governance_event", message);
    
    const latency = Date.now() - startTime;
    logger.info(`[GovernanceWebSocket] Vote update broadcast for ${proposalId} (${latency}ms)`);
    
    if (latency > 200) {
      logger.warn(`[GovernanceWebSocket] Vote update broadcast exceeded 200ms threshold: ${latency}ms`);
    }
  } catch (error) {
    logger.error(`[GovernanceWebSocket] Failed to broadcast vote update for ${proposalId}:`, error);
  }
}

/**
 * Broadcasts a timelock status change to all clients in a proposal room.
 * Target latency: < 200ms
 */
export function broadcastTimelockStatus(proposalId: string, statusData: TimelockStatusEvent): void {
  const startTime = Date.now();
  
  try {
    const io = getIO();
    const message: GovernanceMessage = {
      type: "timelock_status",
      proposalId,
      data: statusData,
      timestamp: startTime,
    };

    io.to(`governance:${proposalId}`).emit("governance_event", message);
    
    const latency = Date.now() - startTime;
    logger.info(`[GovernanceWebSocket] Timelock status broadcast for ${proposalId} (${latency}ms)`);
    
    if (latency > 200) {
      logger.warn(`[GovernanceWebSocket] Timelock status broadcast exceeded 200ms threshold: ${latency}ms`);
    }
  } catch (error) {
    logger.error(`[GovernanceWebSocket] Failed to broadcast timelock status for ${proposalId}:`, error);
  }
}

// ─── Socket Handler Registration ───────────────────────────────────────────

/**
 * Registers governance WebSocket event handlers.
 */
export function registerGovernanceHandlers(io: Server): void {
  io.on("connection", (socket: Socket) => {
    logger.info(`[GovernanceWebSocket] New connection: ${socket.id}`);

    // Join a proposal room
    socket.on(
      "governance:join",
      (proposalId: string, callback: (response: { success: boolean; error?: string }) => void) => {
        try {
          if (!proposalId || typeof proposalId !== "string") {
            callback({ success: false, error: "Invalid proposal ID" });
            return;
          }

          joinProposalRoom(socket, proposalId);
          callback({ success: true });
        } catch (error) {
          logger.error(`[GovernanceWebSocket] Error joining proposal room:`, error);
          callback({ success: false, error: "Failed to join proposal room" });
        }
      },
    );

    // Leave a proposal room
    socket.on(
      "governance:leave",
      (proposalId: string, callback: (response: { success: boolean }) => void) => {
        try {
          leaveProposalRoom(socket, proposalId);
          callback({ success: true });
        } catch (error) {
          logger.error(`[GovernanceWebSocket] Error leaving proposal room:`, error);
          callback({ success: false });
        }
      },
    );

    // Handle chat messages with sanitization
    socket.on(
      "governance:chat",
      (
        data: { proposalId: string; content: string; userId: string },
        callback: (response: { success: boolean; error?: string; sanitizedContent?: string }) => void,
      ) => {
        try {
          const { proposalId, content, userId } = data;

          if (!proposalId || !content || !userId) {
            callback({ success: false, error: "Missing required fields" });
            return;
          }

          // Sanitize the message content
          const sanitizedContent = sanitizeChatMessage(content);

          if (sanitizedContent.length === 0) {
            callback({ success: false, error: "Message content is empty after sanitization" });
            return;
          }

          // Create comment event
          const commentEvent: CommentEvent = {
            commentId: `${Date.now()}-${socket.id}`,
            userId,
            content: sanitizedContent,
            createdAt: new Date().toISOString(),
          };

          // Broadcast to the proposal room
          broadcastComment(proposalId, commentEvent);

          callback({ success: true, sanitizedContent });
        } catch (error) {
          logger.error(`[GovernanceWebSocket] Error handling chat message:`, error);
          callback({ success: false, error: "Failed to process chat message" });
        }
      },
    );

    // Clean up on disconnect
    socket.on("disconnect", () => {
      leaveAllProposalRooms(socket);
      logger.info(`[GovernanceWebSocket] Disconnection: ${socket.id}`);
    });
  });

  logger.info("[GovernanceWebSocket] Governance handlers registered");
}

// ─── Metrics ───────────────────────────────────────────────────────────────

/**
 * Gets the number of active clients in a proposal room.
 */
export function getProposalRoomClientCount(proposalId: string): number {
  const room = proposalRooms.get(proposalId);
  return room ? room.clients.size : 0;
}

/**
 * Gets the total number of active proposal rooms.
 */
export function getActiveProposalRoomCount(): number {
  return proposalRooms.size;
}
