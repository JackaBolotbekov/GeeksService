import type {
  ActionResult,
  ClaimableRole,
  GameState,
  MusicPlayback,
  SessionIdentity,
  ViewerRole,
  YouTubeTrack,
} from "../shared/types";

interface Participant {
  socketId: string | null;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  score: number;
}

interface SnapshotParticipant {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  score: number;
}

export interface GameRoomSnapshot {
  version: 1;
  players: SnapshotParticipant[];
  queue: SnapshotParticipant[];
  buzzerUserId: string | null;
  winnerUserId: string | null;
  round: number;
  scoreEvent: GameState["scoreEvent"];
  track: YouTubeTrack | null;
  musicPlayback: MusicPlayback;
  answerAttempt: GameState["answerAttempt"];
}

const ok = (): ActionResult => ({ ok: true });
const fail = (message: string): ActionResult => ({ ok: false, message });
const ANSWER_WINDOW_MS = 10_000;
const MAX_PLAYERS = 4;

export class GameRoom {
  private hostSocketId: string | null = null;
  private players: Participant[] = [];
  private queue: Participant[] = [];
  private buzzerUserId: string | null = null;
  private winnerUserId: string | null = null;
  private round = 1;
  private scoreEvent: GameState["scoreEvent"] = null;
  private scoreEventId = 0;
  private track: YouTubeTrack | null = null;
  private musicPlayback: MusicPlayback = "idle";
  private answerAttempt: GameState["answerAttempt"] = null;

  constructor(snapshot: GameRoomSnapshot | null = null) {
    if (!snapshot || snapshot.version !== 1) return;
    const restoreParticipant = (participant: SnapshotParticipant): Participant => ({
      socketId: null,
      userId: participant.userId,
      displayName: participant.displayName,
      avatarUrl: participant.avatarUrl,
      score: Math.max(0, Number(participant.score) || 0),
    });
    this.players = snapshot.players.slice(0, MAX_PLAYERS).map(restoreParticipant);
    this.queue = snapshot.queue.map(restoreParticipant);
    this.buzzerUserId = snapshot.buzzerUserId;
    this.winnerUserId = snapshot.winnerUserId;
    this.round = Math.max(1, Number(snapshot.round) || 1);
    this.scoreEvent = snapshot.scoreEvent;
    this.track = snapshot.track;
    this.musicPlayback = snapshot.musicPlayback === "playing" ? "paused" : snapshot.musicPlayback;
    this.answerAttempt = snapshot.answerAttempt;
    if (this.answerAttempt && this.answerAttempt.deadlineAt <= Date.now()) {
      this.clearAnswerAttempt();
    }
  }

  claim(socketId: string, identity: SessionIdentity | null, role: ClaimableRole): ActionResult {
    if (role === "host") {
      if (this.hostSocketId === socketId) return ok();
      if (this.hostSocketId) return fail("Место ведущего уже занято");
      this.release(socketId);
      this.hostSocketId = socketId;
      return ok();
    }

    if (!identity?.displayName) return fail("Сначала укажите игровое имя");
    const currentParticipant =
      this.players.find((participant) => participant.socketId === socketId) ??
      this.queue.find((participant) => participant.socketId === socketId);
    if (currentParticipant?.userId === identity.sub) return ok();
    const existingParticipant =
      this.players.find((participant) => participant.userId === identity.sub) ??
      this.queue.find((participant) => participant.userId === identity.sub);
    if (existingParticipant?.socketId === null) {
      existingParticipant.socketId = socketId;
      existingParticipant.displayName = identity.displayName;
      existingParticipant.avatarUrl = identity.avatarUrl;
      return ok();
    }
    if (existingParticipant) {
      return fail("Этот игрок уже участвует");
    }
    this.release(socketId);
    const participant: Participant = {
      socketId,
      userId: identity.sub,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      score: 0,
    };
    if (this.players.length < MAX_PLAYERS) this.players.push(participant);
    else this.queue.push(participant);
    return ok();
  }

  release(socketId: string): ActionResult {
    if (this.hostSocketId === socketId) {
      this.hostSocketId = null;
      this.track = null;
      this.musicPlayback = "idle";
      this.clearAnswerAttempt();
    }
    const playerIndex = this.players.findIndex((player) => player.socketId === socketId);
    if (playerIndex >= 0) {
      const [removed] = this.players.splice(playerIndex, 1);
      if (removed.userId === this.buzzerUserId) this.buzzerUserId = null;
      if (removed.userId === this.winnerUserId) this.winnerUserId = null;
      if (removed.userId === this.answerAttempt?.userId) this.clearAnswerAttempt();
      this.promoteQueue();
    }
    this.queue = this.queue.filter((participant) => participant.socketId !== socketId);
    return ok();
  }

  disconnect(socketId: string): void {
    this.release(socketId);
  }

  pressBuzzer(socketId: string): ActionResult {
    if (this.winnerUserId) return fail("Матч завершён");
    if (this.answerAttempt) return fail("Сейчас отвечает другой игрок");
    const player = this.players.find((participant) => participant.socketId === socketId);
    if (!player) return fail("Только активный игрок может нажать кнопку");
    this.buzzerUserId = player.userId;
    this.answerAttempt = this.createAnswerAttempt(player.userId, 1, []);
    return ok();
  }

  score(socketId: string, userId: string, delta: 1 | -1): ActionResult {
    if (!this.isHost(socketId)) return fail("Только ведущий меняет счёт");
    if (this.winnerUserId) return fail("Сначала сбросьте завершённый матч");
    const player = this.players.find((participant) => participant.userId === userId);
    if (!player) return fail("Игрок не найден");
    if (this.answerAttempt && this.answerAttempt.userId !== userId) {
      return fail("Сейчас отвечает другой игрок");
    }

    player.score = delta === 1 ? player.score + 1 : Math.max(0, player.score - 1);
    this.scoreEvent = { id: ++this.scoreEventId, userId, delta };
    this.players.sort((left, right) => right.score - left.score);
    if (player.score >= 10) this.winnerUserId = player.userId;
    if (this.winnerUserId || delta === 1 || !this.answerAttempt) {
      this.nextRoundInternal();
      return ok();
    }

    const previousWrongUserIds = [...this.answerAttempt.previousWrongUserIds, userId];
    const nextPlayer = this.players.find((participant) => !previousWrongUserIds.includes(participant.userId));
    if (nextPlayer) {
      this.buzzerUserId = nextPlayer.userId;
      this.answerAttempt = this.createAnswerAttempt(
        nextPlayer.userId,
        previousWrongUserIds.length + 1,
        previousWrongUserIds,
      );
      return ok();
    }

    this.nextRoundInternal();
    return ok();
  }

  nextRound(socketId: string): ActionResult {
    if (!this.isHost(socketId)) return fail("Только ведущий начинает раунд");
    if (this.winnerUserId) return fail("Сначала сбросьте завершённый матч");
    this.nextRoundInternal();
    return ok();
  }

  resetMatch(socketId: string): ActionResult {
    if (!this.isHost(socketId)) return fail("Только ведущий сбрасывает матч");
    this.players.forEach((player) => {
      player.score = 0;
    });
    this.buzzerUserId = null;
    this.winnerUserId = null;
    this.scoreEvent = null;
    this.track = null;
    this.musicPlayback = "idle";
    this.clearAnswerAttempt();
    this.round = 1;
    return ok();
  }

  removePlayer(socketId: string, userId: string): ActionResult {
    if (!this.isHost(socketId)) return fail("Только ведущий освобождает место");
    const player = this.players.find((participant) => participant.userId === userId);
    if (!player) return fail("Игрок не найден");
    if (player.socketId) {
      this.release(player.socketId);
    } else {
      this.players = this.players.filter((participant) => participant.userId !== userId);
      if (userId === this.buzzerUserId) this.buzzerUserId = null;
      if (userId === this.winnerUserId) this.winnerUserId = null;
      if (userId === this.answerAttempt?.userId) this.clearAnswerAttempt();
      this.promoteQueue();
    }
    return ok();
  }

  toSnapshot(): GameRoomSnapshot {
    const snapshotParticipant = (participant: Participant): SnapshotParticipant => ({
      userId: participant.userId,
      displayName: participant.displayName,
      avatarUrl: participant.avatarUrl,
      score: participant.score,
    });
    return {
      version: 1,
      players: this.players.map(snapshotParticipant),
      queue: this.queue.map(snapshotParticipant),
      buzzerUserId: this.buzzerUserId,
      winnerUserId: this.winnerUserId,
      round: this.round,
      scoreEvent: this.scoreEvent,
      track: this.track,
      musicPlayback: this.musicPlayback,
      answerAttempt: this.answerAttempt,
    };
  }

  selectTrack(socketId: string, track: YouTubeTrack): ActionResult {
    if (!this.isHost(socketId)) return fail("Только ведущий выбирает песню");
    this.track = track;
    this.musicPlayback = "playing";
    this.clearAnswerAttempt();
    return ok();
  }

  setMusicPlayback(socketId: string, playback: MusicPlayback): ActionResult {
    if (!this.isHost(socketId)) return fail("Только ведущий управляет музыкой");
    this.musicPlayback = playback;
    return ok();
  }

  isHostSocket(socketId: string): boolean {
    return this.isHost(socketId);
  }

  getState(socketId: string): GameState {
    const role = this.getRole(socketId);
    const participant =
      this.players.find((player) => player.socketId === socketId) ??
      this.queue.find((queued) => queued.socketId === socketId);
    const queueIndex = this.queue.findIndex((queued) => queued.socketId === socketId);

    return {
      players: this.players.map((player) => ({
        userId: player.userId,
        displayName: player.displayName,
        avatarUrl: player.avatarUrl,
        score: player.score,
        isBuzzed: player.userId === this.buzzerUserId,
        isAnswering: player.userId === this.answerAttempt?.userId,
        hasAttemptedThisRound:
          player.userId === this.answerAttempt?.userId ||
          Boolean(this.answerAttempt?.previousWrongUserIds.includes(player.userId)),
      })),
      viewer: {
        role,
        userId: participant?.userId ?? null,
        queuePosition: queueIndex >= 0 ? queueIndex + 1 : null,
      },
      hostConnected: Boolean(this.hostSocketId),
      buzzerUserId: this.buzzerUserId,
      winnerUserId: this.winnerUserId,
      round: this.round,
      scoreEvent: this.scoreEvent,
      track: this.track,
      musicPlayback: this.musicPlayback,
      answerAttempt: this.answerAttempt,
    };
  }

  private getRole(socketId: string): ViewerRole {
    if (this.hostSocketId === socketId) return "host";
    if (this.players.some((player) => player.socketId === socketId)) return "player";
    if (this.queue.some((player) => player.socketId === socketId)) return "spectator";
    return "none";
  }

  private isHost(socketId: string): boolean {
    return this.hostSocketId === socketId;
  }

  private nextRoundInternal(): void {
    this.clearAnswerAttempt();
    this.musicPlayback = "idle";
    this.round += 1;
  }

  private promoteQueue(): void {
    while (this.players.length < MAX_PLAYERS) {
      const next = this.queue.shift();
      if (!next) return;
      next.score = 0;
      this.players.push(next);
      this.players.sort((left, right) => right.score - left.score);
    }
  }

  private createAnswerAttempt(
    userId: string,
    attemptNumber: number,
    previousWrongUserIds: string[],
  ): NonNullable<GameState["answerAttempt"]> {
    const startedAt = Date.now();
    return {
      userId,
      attemptNumber,
      previousWrongUserIds,
      startedAt,
      deadlineAt: startedAt + ANSWER_WINDOW_MS,
    };
  }

  private clearAnswerAttempt(): void {
    this.buzzerUserId = null;
    this.answerAttempt = null;
  }
}
