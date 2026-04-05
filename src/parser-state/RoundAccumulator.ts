import type { PlayerRef, Side, UtilityName } from "../parser-core";
import type {
  RoundScore,
  RoundWinReason,
} from "../parser-events";
import type {
  BombSite,
  DerivedRoundWinReason,
  RoundPlayerIdentity,
  RoundSummary,
  UtilityStats,
} from "../parser-types";

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

type RoundPlayerSeed = {
  id: string;
  name: string;
  side: Side | null;
};

export class RoundAccumulator {
  private readonly players = new Map<string, RoundPlayerRecord>();
  private endedAt: string | null = null;
  private isComplete = false;
  private winningOrganization: string | null = null;
  private winningSide: Side | null = null;
  private winReason: RoundWinReason | null = null;
  private derivedWinReason: DerivedRoundWinReason | null = null;
  private score: RoundScore | null = null;
  private bombPlanted = false;
  private bombDefused = false;
  private bombSite: BombSite | null = null;
  private bombPlantedBy: RoundPlayerIdentity | null = null;
  private bombDefusedBy: RoundPlayerIdentity | null = null;

  constructor(
    private readonly number: number,
    private readonly startedAt: string,
  ) {}

  getWinningSide(): Side | null {
    return this.winningSide;
  }

  seedPlayers(players: Iterable<RoundPlayerSeed>): void {
    for (const player of players) {
      if (!player.side) {
        continue;
      }

      this.players.set(player.id, {
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

  recordScore(score: RoundScore): void {
    this.score = score;
  }

  recordOutcome(outcome: {
    winningSide: Side | null;
    reason: RoundWinReason;
  }): void {
    this.winningSide = outcome.winningSide;
    this.winReason = outcome.reason;
  }

  recordBombPlant(event: {
    player: PlayerRef;
    site: BombSite | null;
  }): void {
    this.bombPlanted = true;
    this.bombSite = event.site;
    this.bombPlantedBy = toRoundPlayerIdentity(event.player);
    this.upsertPlayer(event.player);
  }

  recordBombDefuse(event: { player: PlayerRef }): void {
    this.bombDefused = true;
    this.bombDefusedBy = toRoundPlayerIdentity(event.player);
    this.upsertPlayer(event.player);
  }

  recordUtilityPurchase(player: PlayerRef, utility: UtilityName): void {
    incrementUtilityStat(this.upsertPlayer(player).utilityBought, utility);
  }

  applyPendingUtilityPurchase(player: PlayerRef, utilityBought: UtilityStats): void {
    const roundPlayerRecord = this.upsertPlayer(player);

    for (const utility of Object.keys(utilityBought) as UtilityName[]) {
      roundPlayerRecord.utilityBought[utility] += utilityBought[utility];
    }
  }

  recordAttack(event: {
    attacker: PlayerRef;
    damage: number;
    hitgroup: string | null;
  }): void {
    const attackerRoundRecord = this.upsertPlayer(event.attacker);
    attackerRoundRecord.damage += event.damage;

    if (event.hitgroup === "head" && event.damage > 0) {
      attackerRoundRecord.headDamage += event.damage;
    }
  }

  recordUtilityThrow(player: PlayerRef, utility: UtilityName): void {
    incrementUtilityStat(this.upsertPlayer(player).utilityThrown, utility);
  }

  recordKill(event: {
    killer: PlayerRef;
    victim: PlayerRef;
    isHeadshot: boolean;
  }): void {
    const killerRoundRecord = this.upsertPlayer(event.killer);
    const victimRoundRecord = this.upsertPlayer(event.victim);

    killerRoundRecord.kills += 1;
    victimRoundRecord.deaths += 1;

    if (event.isHeadshot) {
      killerRoundRecord.headshotKills += 1;
    }
  }

  recordAssist(event: { assister: PlayerRef; isFlashAssist: boolean }): void {
    const assisterRoundRecord = this.upsertPlayer(event.assister);
    assisterRoundRecord.assists += 1;

    if (event.isFlashAssist) {
      assisterRoundRecord.flashAssists += 1;
    }
  }

  finalize(
    endedAt: string | null,
    isComplete: boolean,
    winningOrganization: string | null,
  ): RoundSummary {
    this.endedAt = endedAt;
    this.isComplete = isComplete;
    this.winningOrganization = winningOrganization;
    this.derivedWinReason = deriveRoundWinReason({
      winReason: this.winReason,
      bombPlanted: this.bombPlanted,
      players: this.players,
    });

    return {
      number: this.number,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      isComplete: this.isComplete,
      winningOrganization: this.winningOrganization,
      winningSide: this.winningSide,
      winReason: this.winReason,
      derivedWinReason: this.derivedWinReason,
      score: this.score,
      bombPlanted: this.bombPlanted,
      bombDefused: this.bombDefused,
      bombSite: this.bombSite,
      bombPlantedBy: this.bombPlantedBy,
      bombDefusedBy: this.bombDefusedBy,
      players: [...this.players.values()],
    };
  }

  private upsertPlayer(player: PlayerRef): RoundPlayerRecord {
    const existing = this.players.get(player.key);

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

    this.players.set(player.key, created);
    return created;
  }
}

function toRoundPlayerIdentity(player: PlayerRef): RoundPlayerIdentity {
  return {
    id: player.key,
    name: player.name,
    side: player.side,
  };
}

function deriveRoundWinReason(round: {
  winReason: RoundWinReason | null;
  bombPlanted: boolean;
  players: Map<string, RoundPlayerRecord>;
}): DerivedRoundWinReason | null {
  if (round.winReason === "bomb_defused") {
    return "bomb_defused";
  }

  if (round.winReason === "bomb_exploded") {
    return "bomb_exploded";
  }

  const ctDeaths = countDeathsForSide(round.players, "CT");
  const tDeaths = countDeathsForSide(round.players, "T");
  const ctPlayers = countPlayersForSide(round.players, "CT");
  const tPlayers = countPlayersForSide(round.players, "T");
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

function countPlayersForSide(
  players: Map<string, RoundPlayerRecord>,
  side: Side,
): number {
  let count = 0;

  for (const player of players.values()) {
    if (player.side === side) {
      count += 1;
    }
  }

  return count;
}

function countDeathsForSide(
  players: Map<string, RoundPlayerRecord>,
  side: Side,
): number {
  let count = 0;

  for (const player of players.values()) {
    if (player.side === side) {
      count += player.deaths;
    }
  }

  return count;
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
