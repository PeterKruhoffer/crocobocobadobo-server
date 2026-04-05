import type { PlayerRef, Side, UtilityName } from "../parser-core";
import type { RoundScore, RoundWinReason } from "../parser-events";
import type {
  BombSite,
  DerivedRoundWinReason,
  ParsedLogResponse,
  RoundPlayerIdentity,
  RoundSummary,
  UtilityStats,
} from "../parser-types";

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

type RoundPlayerRecord = {
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

type RoundRecord = {
  number: number;
  startedAt: string | null;
  endedAt: string | null;
  isComplete: boolean;
  winningOrganization: string | null;
  winningSide: Side | null;
  winReason: RoundWinReason | null;
  derivedWinReason: DerivedRoundWinReason | null;
  score: RoundScore | null;
  bombPlanted: boolean;
  bombDefused: boolean;
  bombSite: BombSite | null;
  bombPlantedBy: RoundPlayerIdentity | null;
  bombDefusedBy: RoundPlayerIdentity | null;
  players: Map<string, RoundPlayerRecord>;
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
  private currentRound: RoundRecord | null = null;
  private readonly players = new Map<string, PlayerRecord>();
  private readonly rounds: RoundRecord[] = [];
  private readonly teamOrganizations: TeamOrganizations = { CT: null, T: null };
  private readonly pendingUtilityPurchases = new Map<
    string,
    PendingUtilityPurchaseRecord
  >();

  isRoundLive(): boolean {
    return this.roundLive;
  }

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
    if (this.currentRound) {
      this.currentRound.score = score;
    }
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

    this.currentRound.winningSide = roundOutcome.winningSide;
    this.currentRound.winReason = roundOutcome.reason;
    return true;
  }

  applyBombPlant(event: { player: PlayerRef; site: BombSite | null }): boolean {
    if (!this.currentRound || !isTrackablePlayer(event.player)) {
      return false;
    }

    this.currentRound.bombPlanted = true;
    this.currentRound.bombSite = event.site;
    this.currentRound.bombPlantedBy = toRoundPlayerIdentity(event.player);
    upsertRoundPlayer(this.currentRound, event.player);
    return true;
  }

  applyBombDefuse(event: { player: PlayerRef }): boolean {
    if (!this.currentRound || !isTrackablePlayer(event.player)) {
      return false;
    }

    this.currentRound.bombDefused = true;
    this.currentRound.bombDefusedBy = toRoundPlayerIdentity(event.player);
    upsertRoundPlayer(this.currentRound, event.player);
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
      finalizeRound(
        this.currentRound,
        this.rounds,
        this.teamOrganizations,
        startedAt,
        false,
      );
    }

    this.currentRound = createRoundRecord(
      this.latestRoundsPlayed !== null
        ? this.latestRoundsPlayed + 1
        : this.rounds.length + 1,
      startedAt,
    );
    seedRoundPlayers(this.currentRound, this.players);
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

    const playerRecord = upsertPlayer(this.players, event.player);
    incrementUtilityStat(playerRecord.utilityBought, event.utility);

    if (this.currentRound) {
      const playerRoundRecord = upsertRoundPlayer(
        this.currentRound,
        event.player,
      );
      incrementUtilityStat(playerRoundRecord.utilityBought, event.utility);
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
      !isTrackablePlayer(event.attacker) ||
      !isTrackablePlayer(event.victim)
    ) {
      return false;
    }

    const attackerRecord = upsertPlayer(this.players, event.attacker);
    const attackerRoundRecord = upsertRoundPlayer(
      this.currentRound,
      event.attacker,
    );

    attackerRecord.damage += event.damage;
    attackerRoundRecord.damage += event.damage;

    if (event.hitgroup === "head" && event.damage > 0) {
      attackerRecord.headDamage += event.damage;
      attackerRoundRecord.headDamage += event.damage;
    }

    return true;
  }

  applyUtilityThrow(event: {
    player: PlayerRef;
    utility: UtilityName;
  }): boolean {
    if (!isTrackablePlayer(event.player)) {
      return false;
    }

    const playerRecord = upsertPlayer(this.players, event.player);
    const playerRoundRecord = upsertRoundPlayer(
      this.currentRound,
      event.player,
    );

    incrementUtilityStat(playerRecord.utilityThrown, event.utility);
    incrementUtilityStat(playerRoundRecord.utilityThrown, event.utility);
    return true;
  }

  applyKill(event: {
    killer: PlayerRef;
    victim: PlayerRef;
    isHeadshot: boolean;
  }): boolean {
    if (!isTrackablePlayer(event.killer) || !isTrackablePlayer(event.victim)) {
      return false;
    }

    const killerRecord = upsertPlayer(this.players, event.killer);
    const victimRecord = upsertPlayer(this.players, event.victim);
    const killerRoundRecord = upsertRoundPlayer(
      this.currentRound,
      event.killer,
    );
    const victimRoundRecord = upsertRoundPlayer(
      this.currentRound,
      event.victim,
    );

    killerRecord.kills += 1;
    victimRecord.deaths += 1;
    killerRoundRecord.kills += 1;
    victimRoundRecord.deaths += 1;

    if (event.isHeadshot) {
      killerRecord.headshotKills += 1;
      killerRoundRecord.headshotKills += 1;
    }

    return true;
  }

  applyAssist(event: {
    assister: PlayerRef;
    victim: PlayerRef;
    isFlashAssist: boolean;
  }): boolean {
    if (
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
    const assisterRoundRecord = upsertRoundPlayer(
      this.currentRound,
      event.assister,
    );

    assisterRecord.assists += 1;
    assisterRoundRecord.assists += 1;

    if (event.isFlashAssist) {
      assisterRecord.flashAssists += 1;
      assisterRoundRecord.flashAssists += 1;
    }

    return true;
  }

  finish(): ParsedLogResponse {
    if (this.currentRound) {
      finalizeRound(
        this.currentRound,
        this.rounds,
        this.teamOrganizations,
        null,
        false,
      );
      this.currentRound = null;
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
      rounds: this.rounds.map(finalizeRoundRecord),
    };
  }

  private closeCurrentRound(endedAt: string, isComplete: boolean): void {
    if (this.currentRound) {
      finalizeRound(
        this.currentRound,
        this.rounds,
        this.teamOrganizations,
        endedAt,
        isComplete,
      );
      this.currentRound = null;
    }

    // Restart markers show up around the transition from setup to live play,
    // so they should always close the current counting window.
    this.roundLive = false;
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
  const existing = players.get(player.key);

  if (existing) {
    existing.name = player.name;

    if (player.side) {
      existing.side = player.side;
    }

    return existing;
  }

  const created: PlayerRecord = {
    id: player.key,
    name: player.name,
    side: player.side,
    kills: 0,
    deaths: 0,
    assists: 0,
    flashAssists: 0,
    damage: 0,
    headDamage: 0,
    headshotKills: 0,
    utilityBought: createEmptyUtilityStats(),
    utilityThrown: createEmptyUtilityStats(),
  };

  players.set(player.key, created);
  return created;
}

function createRoundRecord(number: number, startedAt: string): RoundRecord {
  return {
    number,
    startedAt,
    endedAt: null,
    isComplete: false,
    winningOrganization: null,
    winningSide: null,
    winReason: null,
    derivedWinReason: null,
    score: null,
    bombPlanted: false,
    bombDefused: false,
    bombSite: null,
    bombPlantedBy: null,
    bombDefusedBy: null,
    players: new Map<string, RoundPlayerRecord>(),
  };
}

function finalizeRound(
  round: RoundRecord,
  rounds: RoundRecord[],
  teamOrganizations: TeamOrganizations,
  endedAt: string | null,
  isComplete: boolean,
): void {
  round.endedAt = endedAt;
  round.isComplete = isComplete;
  round.winningOrganization = resolveOrganizationForSide(
    round.winningSide,
    teamOrganizations,
  );
  round.derivedWinReason = deriveRoundWinReason(round);
  rounds.push(round);
}

function finalizeRoundRecord(round: RoundRecord): RoundSummary {
  return {
    number: round.number,
    startedAt: round.startedAt,
    endedAt: round.endedAt,
    isComplete: round.isComplete,
    winningOrganization: round.winningOrganization,
    winningSide: round.winningSide,
    winReason: round.winReason,
    derivedWinReason: round.derivedWinReason,
    score: round.score,
    bombPlanted: round.bombPlanted,
    bombDefused: round.bombDefused,
    bombSite: round.bombSite,
    bombPlantedBy: round.bombPlantedBy,
    bombDefusedBy: round.bombDefusedBy,
    players: [...round.players.values()],
  };
}

function seedRoundPlayers(
  round: RoundRecord,
  players: Map<string, PlayerRecord>,
): void {
  for (const player of players.values()) {
    if (!player.side) {
      continue;
    }

    round.players.set(player.id, {
      id: player.id,
      name: player.name,
      side: player.side,
      kills: 0,
      deaths: 0,
      assists: 0,
      flashAssists: 0,
      damage: 0,
      headDamage: 0,
      headshotKills: 0,
      utilityBought: createEmptyUtilityStats(),
      utilityThrown: createEmptyUtilityStats(),
    });
  }
}

function upsertRoundPlayer(
  round: RoundRecord | null,
  player: PlayerRef,
): RoundPlayerRecord {
  if (!round) {
    throw new Error("Cannot track round stats without an active round");
  }

  const existing = round.players.get(player.key);

  if (existing) {
    existing.name = player.name;

    if (player.side) {
      existing.side = player.side;
    }

    return existing;
  }

  const created: RoundPlayerRecord = {
    id: player.key,
    name: player.name,
    side: player.side,
    kills: 0,
    deaths: 0,
    assists: 0,
    flashAssists: 0,
    damage: 0,
    headDamage: 0,
    headshotKills: 0,
    utilityBought: createEmptyUtilityStats(),
    utilityThrown: createEmptyUtilityStats(),
  };

  round.players.set(player.key, created);
  return created;
}

function isTrackablePlayer(player: PlayerRef): boolean {
  return player.side !== null;
}

function toRoundPlayerIdentity(player: PlayerRef): RoundPlayerIdentity {
  return {
    id: player.key,
    name: player.name,
    side: player.side,
  };
}

function deriveRoundWinReason(
  round: RoundRecord,
): DerivedRoundWinReason | null {
  if (round.winReason === "bomb_defused") {
    return "bomb_defused";
  }

  if (round.winReason === "bomb_exploded") {
    return "bomb_exploded";
  }

  const ctDeaths = countDeathsForSide(round, "CT");
  const tDeaths = countDeathsForSide(round, "T");
  const ctPlayers = countPlayersForSide(round, "CT");
  const tPlayers = countPlayersForSide(round, "T");
  const allCtsDead = ctPlayers > 0 && ctDeaths >= ctPlayers;
  const allTsDead = tPlayers > 0 && tDeaths >= tPlayers;

  if (round.winReason === "cts_win") {
    if (allTsDead) {
      return "team_wipe";
    }

    if (!round.bombPlanted) {
      return "time_ran_out";
    }
  }

  if (round.winReason === "terrorists_win" && allCtsDead) {
    return round.bombPlanted ? "post_plant_elimination" : "team_wipe";
  }

  return null;
}

function countPlayersForSide(round: RoundRecord, side: Side): number {
  let count = 0;

  for (const player of round.players.values()) {
    if (player.side === side) {
      count += 1;
    }
  }

  return count;
}

function countDeathsForSide(round: RoundRecord, side: Side): number {
  let count = 0;

  for (const player of round.players.values()) {
    if (player.side === side) {
      count += player.deaths;
    }
  }

  return count;
}

function resolveOrganizationForSide(
  side: Side | null,
  teamOrganizations: TeamOrganizations,
): string | null {
  return side ? teamOrganizations[side] : null;
}

function calculateAdr(damage: number, roundsPlayed: number): number {
  if (roundsPlayed <= 0) {
    return 0;
  }

  return Number((damage / roundsPlayed).toFixed(2));
}

function calculateHeadshotPercentage(
  headshotKills: number,
  kills: number,
): number {
  if (kills <= 0) {
    return 0;
  }

  return Number(((headshotKills / kills) * 100).toFixed(2));
}

function createEmptyUtilityStats(): UtilityStats {
  return {
    flashbang: 0,
    molotov: 0,
    incgrenade: 0,
    smokegrenade: 0,
    hegrenade: 0,
  };
}

function incrementUtilityStat(stats: UtilityStats, utility: UtilityName): void {
  stats[utility] += 1;
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
  round: RoundRecord,
  players: Map<string, PlayerRecord>,
  pendingPurchases: Map<string, PendingUtilityPurchaseRecord>,
): void {
  for (const pendingPurchase of pendingPurchases.values()) {
    const playerRecord = upsertPlayer(players, pendingPurchase.player);
    const roundPlayerRecord = upsertRoundPlayer(round, pendingPurchase.player);

    roundPlayerRecord.name = playerRecord.name;

    if (playerRecord.side) {
      roundPlayerRecord.side = playerRecord.side;
    }

    for (const utility of Object.keys(
      pendingPurchase.utilityBought,
    ) as UtilityName[]) {
      roundPlayerRecord.utilityBought[utility] +=
        pendingPurchase.utilityBought[utility];
    }
  }

  pendingPurchases.clear();
}
