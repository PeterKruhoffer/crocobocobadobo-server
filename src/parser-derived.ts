import type { UtilityName } from "./parser-core";
import type {
  DerivedRoundWinReason,
  RoundWinReason,
  Side,
  UtilityStats,
} from "./parser-types";

type RoundOutcomePlayer = {
  side: Side | null;
  deaths: number;
};

export function resolveOrganizationForSide(
  side: Side | null,
  teamOrganizations: Record<Side, string | null>,
): string | null {
  return side ? teamOrganizations[side] : null;
}

export function calculateAdr(damage: number, roundsPlayed: number): number {
  if (roundsPlayed <= 0) {
    return 0;
  }

  return Number((damage / roundsPlayed).toFixed(2));
}

export function calculateHeadshotPercentage(
  headshotKills: number,
  kills: number,
): number {
  if (kills <= 0) {
    return 0;
  }

  return Number(((headshotKills / kills) * 100).toFixed(2));
}

export function deriveRoundWinReason(round: {
  winReason: RoundWinReason | null;
  bombPlanted: boolean;
  players: Iterable<RoundOutcomePlayer>;
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

export function createEmptyUtilityStats(): UtilityStats {
  return {
    flashbang: 0,
    molotov: 0,
    incgrenade: 0,
    smokegrenade: 0,
    hegrenade: 0,
  };
}

export function incrementUtilityStat(
  stats: UtilityStats,
  utility: UtilityName,
): void {
  stats[utility] += 1;
}

function countPlayersForSide(
  players: Iterable<RoundOutcomePlayer>,
  side: Side,
): number {
  let count = 0;

  for (const player of players) {
    if (player.side === side) {
      count += 1;
    }
  }

  return count;
}

function countDeathsForSide(
  players: Iterable<RoundOutcomePlayer>,
  side: Side,
): number {
  let count = 0;

  for (const player of players) {
    if (player.side === side) {
      count += player.deaths;
    }
  }

  return count;
}
