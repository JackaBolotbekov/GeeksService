import type { Prisma } from "@prisma/client";
import type { GameRoomSnapshot } from "./game-room";
import { getPrismaClient } from "./prisma";

export interface GameSnapshotStore {
  load(): Promise<GameRoomSnapshot | null>;
  save(snapshot: GameRoomSnapshot): Promise<void>;
}

function isSnapshot(value: unknown): value is GameRoomSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<GameRoomSnapshot>;
  return snapshot.version === 1 && Array.isArray(snapshot.players) && Array.isArray(snapshot.queue);
}

class MemoryGameSnapshotStore implements GameSnapshotStore {
  private snapshot: GameRoomSnapshot | null = null;

  async load(): Promise<GameRoomSnapshot | null> {
    return this.snapshot;
  }

  async save(snapshot: GameRoomSnapshot): Promise<void> {
    this.snapshot = snapshot;
  }
}

class PrismaGameSnapshotStore implements GameSnapshotStore {
  async load(): Promise<GameRoomSnapshot | null> {
    const row = await getPrismaClient().gameRoomSnapshot.findUnique({ where: { id: 1 } });
    return isSnapshot(row?.state) ? row.state : null;
  }

  async save(snapshot: GameRoomSnapshot): Promise<void> {
    await getPrismaClient().gameRoomSnapshot.upsert({
      where: { id: 1 },
      create: { id: 1, state: snapshot as unknown as Prisma.InputJsonValue },
      update: { state: snapshot as unknown as Prisma.InputJsonValue },
    });
  }
}

export function createGameSnapshotStore(): GameSnapshotStore {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is not configured; game state uses temporary memory storage.");
    return new MemoryGameSnapshotStore();
  }
  return new PrismaGameSnapshotStore();
}
