import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function getUserLpEarnings(req: Request, res: Response) {
  const { user } = req.params; // Assuming user address is passed as a param

  if (!user) {
    return res.status(400).json({ error: "User address is required." });
  }

  try {
    const snapshots = await prisma.userLpSnapshot.findMany({
      where: { user },
      orderBy: { snapshotDate: "desc" },
    });

    res.json({ user, snapshots });
  } catch (error) {
    res.status(500).json({ error: "Unable to load user LP earnings." });
  }
}
