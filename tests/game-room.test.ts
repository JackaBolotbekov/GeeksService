import { describe, expect, it } from "vitest";
import { GameRoom } from "../src/server/game-room";
import type { SessionIdentity } from "../src/shared/types";

const player = (id: string, name: string): SessionIdentity => ({
  sub: id,
  kind: "dev",
  displayName: name,
  avatarUrl: null,
});

function setup() {
  const room = new GameRoom();
  room.claim("host", null, "host");
  room.claim("one-socket", player("one", "Choko"), "player");
  room.claim("two-socket", player("two", "Meder"), "player");
  return room;
}

describe("GameRoom", () => {
  it("creates a timed answer attempt for the first buzzer", () => {
    const room = setup();
    expect(room.pressBuzzer("two-socket").ok).toBe(true);
    expect(room.pressBuzzer("one-socket").ok).toBe(false);
    const state = room.getState("host");
    expect(state.buzzerUserId).toBe("two");
    expect(state.answerAttempt?.userId).toBe("two");
    expect(state.answerAttempt?.attemptNumber).toBe(1);
    expect((state.answerAttempt?.deadlineAt ?? 0) - (state.answerAttempt?.startedAt ?? 0)).toBe(10_000);
    expect(state.players.find((item) => item.userId === "two")?.isAnswering).toBe(true);
  });

  it("passes a wrong first answer to the opponent and never goes below zero", () => {
    const room = setup();
    room.pressBuzzer("one-socket");
    room.score("host", "one", -1);
    let state = room.getState("host");
    expect(state.players.find((item) => item.userId === "one")?.score).toBe(0);
    expect(state.buzzerUserId).toBe("two");
    expect(state.answerAttempt?.userId).toBe("two");
    expect(state.answerAttempt?.attemptNumber).toBe(2);
    expect(state.answerAttempt?.previousWrongUserIds).toEqual(["one"]);
    expect(state.round).toBe(1);

    room.score("host", "two", -1);
    state = room.getState("host");
    expect(state.answerAttempt).toBeNull();
    expect(state.buzzerUserId).toBeNull();
    expect(state.round).toBe(2);
  });

  it("passes wrong answers through every active player before closing the round", () => {
    const room = setup();
    room.claim("three-socket", player("three", "Aliya"), "player");
    room.claim("four-socket", player("four", "Ermek"), "player");

    room.pressBuzzer("one-socket");
    room.score("host", "one", -1);
    let state = room.getState("host");
    expect(state.answerAttempt?.userId).toBe("two");
    expect(state.answerAttempt?.attemptNumber).toBe(2);
    expect(state.answerAttempt?.previousWrongUserIds).toEqual(["one"]);

    room.score("host", "two", -1);
    state = room.getState("host");
    expect(state.answerAttempt?.userId).toBe("three");
    expect(state.answerAttempt?.attemptNumber).toBe(3);
    expect(state.answerAttempt?.previousWrongUserIds).toEqual(["one", "two"]);

    room.score("host", "three", -1);
    state = room.getState("host");
    expect(state.answerAttempt?.userId).toBe("four");
    expect(state.answerAttempt?.attemptNumber).toBe(4);
    expect(state.answerAttempt?.previousWrongUserIds).toEqual(["one", "two", "three"]);

    room.score("host", "four", -1);
    state = room.getState("host");
    expect(state.answerAttempt).toBeNull();
    expect(state.buzzerUserId).toBeNull();
    expect(state.round).toBe(2);
  });

  it("scores a correct answer and starts a new round", () => {
    const room = setup();
    room.pressBuzzer("one-socket");
    room.score("host", "one", 1);
    const state = room.getState("host");
    expect(state.answerAttempt).toBeNull();
    expect(state.round).toBe(2);
    expect(state.players[0].userId).toBe("one");
    expect(state.players[0].score).toBe(1);
  });

  it("keeps current order on a tied score", () => {
    const room = setup();
    room.score("host", "two", 1);
    room.score("host", "one", 1);
    expect(room.getState("host").players.map((item) => item.userId)).toEqual(["two", "one"]);
  });

  it("allows four active players and queues the fifth", () => {
    const room = setup();
    room.claim("three-socket", player("three", "Aliya"), "player");
    room.claim("four-socket", player("four", "Ermek"), "player");
    room.claim("five-socket", player("five", "Nuray"), "player");

    expect(room.getState("host").players.map((item) => item.userId)).toEqual(["one", "two", "three", "four"]);
    expect(room.getState("three-socket").viewer.role).toBe("player");
    expect(room.getState("four-socket").viewer.role).toBe("player");
    expect(room.getState("five-socket").viewer.role).toBe("spectator");
    expect(room.getState("five-socket").viewer.queuePosition).toBe(1);
  });

  it("promotes the first queued spectator when a player disconnects", () => {
    const room = setup();
    room.claim("three-socket", player("three", "Aliya"), "player");
    room.claim("four-socket", player("four", "Ermek"), "player");
    room.claim("five-socket", player("five", "Nuray"), "player");

    room.disconnect("one-socket");
    const promoted = room.getState("five-socket");
    expect(promoted.viewer.role).toBe("player");
    expect(promoted.players.some((item) => item.userId === "five")).toBe(true);
    expect(promoted.players).toHaveLength(4);
  });

  it("ends at ten points and blocks further score changes until reset", () => {
    const room = setup();
    for (let point = 0; point < 10; point += 1) room.score("host", "one", 1);
    expect(room.getState("host").winnerUserId).toBe("one");
    expect(room.score("host", "two", 1).ok).toBe(false);
    expect(room.resetMatch("host").ok).toBe(true);
    expect(room.getState("host").winnerUserId).toBeNull();
  });

  it("rejects host actions from players", () => {
    const room = setup();
    expect(room.score("one-socket", "one", 1).ok).toBe(false);
    expect(room.removePlayer("one-socket", "two").ok).toBe(false);
  });

  it("clears music state when the host leaves", () => {
    const room = setup();
    room.selectTrack("host", {
      videoId: "video",
      title: "Song",
      channelTitle: "Channel",
      thumbnailUrl: null,
    });
    room.setMusicPlayback("host", "playing");
    room.release("host");
    const state = room.getState("one-socket");
    expect(state.hostConnected).toBe(false);
    expect(state.track).toBeNull();
    expect(state.musicPlayback).toBe("idle");
  });

  it("starts playback when the host selects a track", () => {
    const room = setup();
    expect(room.selectTrack("host", {
      videoId: "video",
      title: "Song",
      channelTitle: "Channel",
      thumbnailUrl: null,
    }).ok).toBe(true);
    expect(room.getState("host").musicPlayback).toBe("playing");
  });

  it("does not let one identity occupy multiple player slots", () => {
    const room = new GameRoom();
    expect(room.claim("one-socket", player("one", "Choko"), "player").ok).toBe(true);
    expect(room.claim("duplicate-socket", player("one", "Choko"), "player").ok).toBe(false);
    expect(room.getState("one-socket").players).toHaveLength(1);
  });

  it("keeps a player's place when the occupied host role claim fails", () => {
    const room = setup();
    expect(room.claim("one-socket", player("one", "Choko"), "host").ok).toBe(false);
    expect(room.getState("one-socket").viewer.role).toBe("player");
  });

  it("restores scores and lets the same identity reclaim its place after restart", () => {
    const room = setup();
    room.score("host", "one", 1);
    const restored = new GameRoom(room.toSnapshot());

    expect(restored.getState("new-host").players.find((item) => item.userId === "one")?.score).toBe(1);
    expect(restored.claim("new-host", null, "host").ok).toBe(true);
    expect(restored.claim("new-one", player("one", "Choko"), "player").ok).toBe(true);
    expect(restored.getState("new-one").viewer.role).toBe("player");
    expect(restored.getState("new-one").players.find((item) => item.userId === "one")?.score).toBe(1);
  });
});
