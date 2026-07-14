CREATE TABLE "game_room_snapshots" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "state" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "game_room_snapshots_pkey" PRIMARY KEY ("id")
);
