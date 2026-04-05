import type { PlayerRef, UtilityName } from "../parser-core";
import {
  calculateAdr,
  calculateHeadshotPercentage,
  createEmptyUtilityStats,
  incrementUtilityStat,
  resolveOrganizationForSide,
} from "../parser-derived";
import type { ParserEvent } from "../parser-events";
import type {
  BombSite,
  ParsedLogResponse,
  RoundScore,
  RoundSummary,
  RoundWinReason,
  Side,
  UtilityStats,
} from "@/parser-types";
import { RoundAccumulator } from "./RoundAccumulator";
import { upsertPlayerRecord } from "./player-records";

type PlayerRecord = {
  id: string;
  name: string;
  side: Side | null;
  kills: number;
  deaths: number;
  assists: number;
  flashAssists: number;
  damage: number;
  headDamage: number;
  headshotKills: number;
  utilityBought: UtilityStats;
  utilityThrown: UtilityStats;
};

type PendingUtilityPurchaseRecord = {
  player: PlayerRef;
  utilityBought: UtilityStats;
};

type TeamOrganizations = {
  CT: string | null;
  T: string | null;
};

export class MatchAccumulator {
  private mapName: string | null = null;
  private isComplete = false;
  private finalScore: RoundScore | null = null;
  private durationMinutes: number | null = null;
  private winningSide: Side | null = null;
  private hasLiveMatchStarted = false;
  private roundLive = false;
  private latestRoundsPlayed: number | null = null;
  private currentRound: RoundAccumulator | null = null;
  private readonly players = new Map<string, PlayerRecord>();
  private readonly rounds: RoundSummary[] = [];
  private readonly teamOrganizations: TeamOrganizations = { CT: null, T: null };
  private readonly pendingUtilityPurchases = new Map<
    string,
    PendingUtilityPurchaseRecord
  >();

  recordGameOver(gameOver: {
    mapName: string;
    score: RoundScore;
    durationMinutes: number;
  }): void {
    this.mapName = gameOver.mapName;
    this.isComplete = true;
    this.finalScore = gameOver.score;
    this.durationMinutes = gameOver.durationMinutes;
    this.winningSide = determineWinningSide(gameOver.score);
    this.currentRound = null;
    this.roundLive = false;
  }

  noteRoundsPlayed(roundsPlayed: number): void {
    this.latestRoundsPlayed = roundsPlayed;

    if (roundsPlayed >= 0) {
      this.hasLiveMatchStarted = true;
    }
  }

  applyScore(score: RoundScore): void {
    this.currentRound?.recordScore(score);
  }

  handleRoundEnd(endedAt: string): void {
    this.closeCurrentRound(endedAt, true);
  }

  handleRoundRestart(endedAt: string): void {
    this.closeCurrentRound(endedAt, false);
  }

  applyRoundOutcome(roundOutcome: {
    winningSide: Side | null;
    reason: RoundWinReason;
  }): boolean {
    if (!this.currentRound) {
      return false;
    }

    this.currentRound.recordOutcome(roundOutcome);
    return true;
  }

  applyBombPlant(event: { player: PlayerRef; site: BombSite | null }): boolean {
    if (!this.currentRound || !isTrackablePlayer(event.player)) {
      return false;
    }

    this.currentRound.recordBombPlant(event);
    return true;
  }

  applyBombDefuse(event: { player: PlayerRef }): boolean {
    if (!this.currentRound || !isTrackablePlayer(event.player)) {
      return false;
    }

    this.currentRound.recordBombDefuse(event);
    return true;
  }

  startRound(startedAt: string): void {
    // Multiple Round_Start markers can appear in the file because of warmup
    // and restart sequences. Gate round activation behind the live-match flag
    // so pre-live kills never contribute to player stats.
    this.roundLive = this.hasLiveMatchStarted;

    if (!this.roundLive) {
      return;
    }

    if (this.currentRound) {
      this.rounds.push(this.finalizeCurrentRound(startedAt, false));
    }

    this.currentRound = new RoundAccumulator(
      this.latestRoundsPlayed !== null
        ? this.latestRoundsPlayed + 1
        : this.rounds.length + 1,
      startedAt,
    );
    this.currentRound.seedPlayers(this.players.values());
    applyPendingUtilityPurchases(
      this.currentRound,
      this.players,
      this.pendingUtilityPurchases,
    );
  }

  applyUtilityPurchase(event: {
    player: PlayerRef;
    utility: UtilityName;
  }): boolean {
    if (!isTrackablePlayer(event.player)) {
      return false;
    }

    if (!this.currentRound && !this.hasLiveMatchStarted) {
      return true;
    }

    const playerRecord = upsertPlayer(this.players, event.player);
    incrementUtilityStat(playerRecord.utilityBought, event.utility);

    if (this.currentRound) {
      this.currentRound.recordUtilityPurchase(event.player, event.utility);
    } else if (this.hasLiveMatchStarted) {
      bufferPendingUtilityPurchase(
        this.pendingUtilityPurchases,
        event.player,
        event.utility,
      );
    }

    return true;
  }

  setTeamPlaying(team: { side: Side; organization: string }): void {
    this.teamOrganizations[team.side] = team.organization;
  }

  applyTeamSwitch(event: { player: PlayerRef; toSide: Side }): void {
    const playerRecord = upsertPlayer(this.players, event.player);
    playerRecord.side = event.toSide;
  }

  applyAttack(event: {
    attacker: PlayerRef;
    victim: PlayerRef;
    damage: number;
    hitgroup: string | null;
  }): boolean {
    if (
      !this.currentRound ||
      !isTrackablePlayer(event.attacker) ||
      !isTrackablePlayer(event.victim)
    ) {
      return false;
    }

    const attackerRecord = upsertPlayer(this.players, event.attacker);
    attackerRecord.damage += event.damage;

    if (event.hitgroup === "head" && event.damage > 0) {
      attackerRecord.headDamage += event.damage;
    }

    this.currentRound.recordAttack({
      attacker: event.attacker,
      damage: event.damage,
      hitgroup: event.hitgroup,
    });
    return true;
  }

  applyUtilityThrow(event: {
    player: PlayerRef;
    utility: UtilityName;
  }): boolean {
    if (!this.currentRound || !isTrackablePlayer(event.player)) {
      return false;
    }

    const playerRecord = upsertPlayer(this.players, event.player);
    incrementUtilityStat(playerRecord.utilityThrown, event.utility);
    this.currentRound.recordUtilityThrow(event.player, event.utility);
    return true;
  }

  applyKill(event: {
    killer: PlayerRef;
    victim: PlayerRef;
    isHeadshot: boolean;
  }): boolean {
    if (
      !this.currentRound ||
      !isTrackablePlayer(event.killer) ||
      !isTrackablePlayer(event.victim)
    ) {
      return false;
    }

    const killerRecord = upsertPlayer(this.players, event.killer);
    const victimRecord = upsertPlayer(this.players, event.victim);
    killerRecord.kills += 1;
    victimRecord.deaths += 1;

    if (event.isHeadshot) {
      killerRecord.headshotKills += 1;
    }

    this.currentRound.recordKill(event);
    return true;
  }

  applyAssist(event: {
    assister: PlayerRef;
    victim: PlayerRef;
    isFlashAssist: boolean;
  }): boolean {
    if (
      !this.currentRound ||
      !isTrackablePlayer(event.assister) ||
      !isTrackablePlayer(event.victim)
    ) {
      return false;
    }

    // Dont count same side assists (flashes) in stats
    if (
      event.assister.side &&
      event.victim.side &&
      event.assister.side === event.victim.side
    ) {
      return false;
    }

    const assisterRecord = upsertPlayer(this.players, event.assister);
    assisterRecord.assists += 1;

    if (event.isFlashAssist) {
      assisterRecord.flashAssists += 1;
    }

    this.currentRound.recordAssist({
      assister: event.assister,
      isFlashAssist: event.isFlashAssist,
    });
    return true;
  }

  /**
   * Applies event based on event type.
   * Returns boolean to indicate if game is over or is still going
   */
  applyEvent(event: ParserEvent, timeStamp: string): boolean {
    switch (event.type) {
      case "game_over":
        this.recordGameOver(event.gameOver);
        return true;
      case "rounds_played":
        this.noteRoundsPlayed(event.roundsPlayed);
        return false;
      case "score":
        this.applyScore(event.score);
        return false;
      case "round_end":
        this.handleRoundEnd(timeStamp);
        return false;
      case "round_restart":
        this.handleRoundRestart(timeStamp);
        return false;
      case "round_outcome":
        this.applyRoundOutcome(event.roundOutcome);
        return false;
      case "bomb_plant":
        this.applyBombPlant(event.bombPlant);
        return false;
      case "bomb_defuse":
        this.applyBombDefuse(event.bombDefuse);
        return false;
      case "round_start":
        this.startRound(timeStamp);
        return false;
      case "utility_purchase":
        this.applyUtilityPurchase(event.utilityPurchase);
        return false;
      case "team_playing":
        this.setTeamPlaying(event.team);
        return false;
      case "team_switch":
        this.applyTeamSwitch(event.teamSwitch);
        return false;
      case "attack":
        this.applyAttack(event.attack);
        return false;
      case "utility_throw":
        this.applyUtilityThrow(event.utilityThrow);
        return false;
      case "kill":
        this.applyKill(event.kill);
        return false;
      case "assist":
        this.applyAssist(event.assist);
        return false;
    }
  }

  finish(): ParsedLogResponse {
    if (this.currentRound) {
      this.rounds.push(this.finalizeCurrentRound(null, false));
    }

    const completedRoundsCount = this.rounds.filter(
      (round) => round.isComplete,
    ).length;

    const finalizedPlayers = [...this.players.values()].map((player) => ({
      ...player,
      organization: resolveOrganizationForSide(
        player.side,
        this.teamOrganizations,
      ),
      adr: calculateAdr(player.damage, completedRoundsCount),
      headshotPercentage: calculateHeadshotPercentage(
        player.headshotKills,
        player.kills,
      ),
    }));

    return {
      mapName: this.mapName,
      isComplete: this.isComplete,
      finalScore: this.finalScore,
      durationMinutes: this.durationMinutes,
      winningSide: this.winningSide,
      winningOrganization: resolveOrganizationForSide(
        this.winningSide,
        this.teamOrganizations,
      ),
      roster: finalizedPlayers,
      rounds: this.rounds,
    };
  }

  private closeCurrentRound(endedAt: string, isComplete: boolean): void {
    if (this.currentRound) {
      this.rounds.push(this.finalizeCurrentRound(endedAt, isComplete));
    }

    // Restart markers show up around the transition from setup to live play,
    // so they should always close the current counting window.
    this.roundLive = false;
  }

  private finalizeCurrentRound(
    endedAt: string | null,
    isComplete: boolean,
  ): RoundSummary {
    if (!this.currentRound) {
      throw new Error("Cannot finalize a round when no round is active");
    }

    const finalizedRound = this.currentRound.finalize(
      endedAt,
      isComplete,
      resolveOrganizationForSide(
        this.currentRound.getWinningSide(),
        this.teamOrganizations,
      ),
    );
    this.currentRound = null;
    return finalizedRound;
  }
}

function determineWinningSide(score: RoundScore): Side | null {
  if (score.CT === score.T) {
    return null;
  }

  return score.CT > score.T ? "CT" : "T";
}

function upsertPlayer(
  players: Map<string, PlayerRecord>,
  player: PlayerRef,
): PlayerRecord {
  return upsertPlayerRecord(players, player, (currentPlayer) => ({
    id: currentPlayer.key,
    name: currentPlayer.name,
    side: currentPlayer.side,
    kills: 0,
    deaths: 0,
    assists: 0,
    flashAssists: 0,
    damage: 0,
    headDamage: 0,
    headshotKills: 0,
    utilityBought: createEmptyUtilityStats(),
    utilityThrown: createEmptyUtilityStats(),
  }));
}

function isTrackablePlayer(player: PlayerRef): boolean {
  return player.side !== null;
}

function bufferPendingUtilityPurchase(
  pendingPurchases: Map<string, PendingUtilityPurchaseRecord>,
  player: PlayerRef,
  utility: UtilityName,
): void {
  const existing = pendingPurchases.get(player.key);

  if (existing) {
    existing.player.name = player.name;

    if (player.side) {
      existing.player.side = player.side;
    }

    incrementUtilityStat(existing.utilityBought, utility);
    return;
  }

  const created: PendingUtilityPurchaseRecord = {
    player: {
      key: player.key,
      name: player.name,
      side: player.side,
    },
    utilityBought: createEmptyUtilityStats(),
  };

  incrementUtilityStat(created.utilityBought, utility);
  pendingPurchases.set(player.key, created);
}

function applyPendingUtilityPurchases(
  round: RoundAccumulator,
  players: Map<string, PlayerRecord>,
  pendingPurchases: Map<string, PendingUtilityPurchaseRecord>,
): void {
  for (const pendingPurchase of pendingPurchases.values()) {
    const playerRecord = upsertPlayer(players, pendingPurchase.player);
    round.applyPendingUtilityPurchase(
      toPlayerRef(playerRecord),
      pendingPurchase.utilityBought,
    );
  }

  pendingPurchases.clear();
}

function toPlayerRef(player: PlayerRecord): PlayerRef {
  return {
    key: player.id,
    name: player.name,
    side: player.side,
  };
}
