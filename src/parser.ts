import {
  parseLineIntoParts,
  type BombSite as ParserCoreBombSite,
  type PlayerRef,
  type Side,
  type UtilityName,
} from "./parser-core";
import {
  extractAssistEvent,
  extractAttackEvent,
  extractBombDefuseEvent,
  extractBombPlantEvent,
  extractGameOver,
  extractKillEvent,
  extractRoundOutcome,
  extractRoundsPlayed,
  extractScore,
  extractTeamPlaying,
  extractTeamSwitch,
  extractUtilityPurchaseEvent,
  extractUtilityThrowEvent,
  isRoundEnd,
  isRoundRestart,
  isRoundStart,
  type RoundScore as ParserEventsRoundScore,
  type RoundWinReason as ParserEventsRoundWinReason,
} from "./parser-events";

export type ParsedLogResponse = {
  mapName: string | null;
  isComplete: boolean;
  finalScore: RoundScore | null;
  durationMinutes: number | null;
  winningSide: Side | null;
  winningOrganization: string | null;
  roster: {
    organization: string | null;
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
    adr: number;
    headshotPercentage: number;
    utilityBought: UtilityStats;
    utilityThrown: UtilityStats;
  }[];
  rounds: RoundSummary[];
};

export type RoundSummary = {
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
  players: {
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
  }[];
};

export type UtilityStats = {
  flashbang: number;
  molotov: number;
  incgrenade: number;
  smokegrenade: number;
  hegrenade: number;
};

export type RoundWinReason = ParserEventsRoundWinReason;

export type DerivedRoundWinReason =
  | "bomb_defused"
  | "bomb_exploded"
  | "team_wipe"
  | "time_ran_out"
  | "post_plant_elimination";

export type BombSite = ParserCoreBombSite;

export type RoundPlayerIdentity = {
  id: string;
  name: string;
  side: Side | null;
};

export type RoundScore = ParserEventsRoundScore;

export function parseMatchLog(log: string): ParsedLogResponse | null {
  let mapName: string | null = null;
  let isComplete = false;
  let finalScore: RoundScore | null = null;
  let durationMinutes: number | null = null;
  let winningSide: Side | null = null;
  let hasLiveMatchStarted = false;
  let isRoundLive = false;
  let latestRoundsPlayed: number | null = null;
  let currentRound: RoundRecord | null = null;
  const players = new Map<string, PlayerRecord>();
  const rounds: RoundRecord[] = [];
  const teamOrganizations: TeamOrganizations = { CT: null, T: null };
  const pendingUtilityPurchases = new Map<
    string,
    PendingUtilityPurchaseRecord
  >();

  const lines = log
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parsedLine = parseLineIntoParts(line);
    if (!parsedLine) {
      continue;
    }

    const { message } = parsedLine;

    const gameOver = extractGameOver(message);
    if (gameOver) {
      mapName = gameOver.mapName;
      isComplete = true;
      finalScore = gameOver.score;
      durationMinutes = gameOver.durationMinutes;
      winningSide = determineWinningSide(gameOver.score);
      currentRound = null;
      isRoundLive = false;
      break;
    }

    const roundsPlayed = extractRoundsPlayed(message);
    if (roundsPlayed !== null) {
      latestRoundsPlayed = roundsPlayed;
    }

    const score = extractScore(message);
    if (score && currentRound) {
      currentRound.score = score;
    }

    if (roundsPlayed !== null && roundsPlayed >= 0) {
      // This log contains warmup/setup phases with Round_Start events before the
      // real match is live. We only consider rounds countable after the match
      // status reports RoundsPlayed >= 0.
      hasLiveMatchStarted = true;
    }

    if (isRoundEnd(message)) {
      if (currentRound) {
        finalizeRound(
          currentRound,
          rounds,
          teamOrganizations,
          parsedLine.timeStamp,
          true,
        );
        currentRound = null;
      }

      // Restart markers show up around the transition from setup to live play,
      // so they should always close the current counting window.
      isRoundLive = false;
      continue;
    }

    if (isRoundRestart(message)) {
      if (currentRound) {
        finalizeRound(
          currentRound,
          rounds,
          teamOrganizations,
          parsedLine.timeStamp,
          false,
        );
        currentRound = null;
      }

      // Restart markers show up around the transition from setup to live play,
      // so they should always close the current counting window.
      isRoundLive = false;
      continue;
    }

    const roundOutcome = extractRoundOutcome(message);
    if (roundOutcome && currentRound) {
      currentRound.winningSide = roundOutcome.winningSide;
      currentRound.winReason = roundOutcome.reason;
      continue;
    }

    const bombPlantEvent = extractBombPlantEvent(message);
    if (
      bombPlantEvent &&
      currentRound &&
      isTrackablePlayer(bombPlantEvent.player)
    ) {
      currentRound.bombPlanted = true;
      currentRound.bombSite = bombPlantEvent.site;
      currentRound.bombPlantedBy = toRoundPlayerIdentity(bombPlantEvent.player);
      upsertRoundPlayer(currentRound, bombPlantEvent.player);
      continue;
    }

    const bombDefuseEvent = extractBombDefuseEvent(message);
    if (
      bombDefuseEvent &&
      currentRound &&
      isTrackablePlayer(bombDefuseEvent.player)
    ) {
      currentRound.bombDefused = true;
      currentRound.bombDefusedBy = toRoundPlayerIdentity(
        bombDefuseEvent.player,
      );
      upsertRoundPlayer(currentRound, bombDefuseEvent.player);
      continue;
    }

    if (isRoundStart(message)) {
      // Multiple Round_Start markers can appear in the file because of warmup
      // and restart sequences. Gate round activation behind the live-match flag
      // so pre-live kills never contribute to player stats.
      isRoundLive = hasLiveMatchStarted;

      if (!isRoundLive) {
        continue;
      }

      if (currentRound) {
        finalizeRound(
          currentRound,
          rounds,
          teamOrganizations,
          parsedLine.timeStamp,
          false,
        );
      }

      currentRound = createRoundRecord(
        latestRoundsPlayed !== null
          ? latestRoundsPlayed + 1
          : rounds.length + 1,
        parsedLine.timeStamp,
      );
      seedRoundPlayers(currentRound, players);
      applyPendingUtilityPurchases(
        currentRound,
        players,
        pendingUtilityPurchases,
      );

      continue;
    }

    const utilityPurchaseEvent = extractUtilityPurchaseEvent(message);
    if (
      utilityPurchaseEvent &&
      isTrackablePlayer(utilityPurchaseEvent.player)
    ) {
      const playerRecord = upsertPlayer(players, utilityPurchaseEvent.player);

      incrementUtilityStat(
        playerRecord.utilityBought,
        utilityPurchaseEvent.utility,
      );

      if (currentRound) {
        const playerRoundRecord = upsertRoundPlayer(
          currentRound,
          utilityPurchaseEvent.player,
        );

        incrementUtilityStat(
          playerRoundRecord.utilityBought,
          utilityPurchaseEvent.utility,
        );
      } else if (hasLiveMatchStarted) {
        bufferPendingUtilityPurchase(
          pendingUtilityPurchases,
          utilityPurchaseEvent.player,
          utilityPurchaseEvent.utility,
        );
      }

      continue;
    }

    const team = extractTeamPlaying(message);
    if (team) {
      teamOrganizations[team.side] = team.organization;
      continue;
    }

    const teamSwitch = extractTeamSwitch(message);
    if (teamSwitch) {
      const playerRecord = upsertPlayer(players, teamSwitch.player);
      playerRecord.side = teamSwitch.toSide;
      continue;
    }

    if (isRoundLive) {
      const attackEvent = extractAttackEvent(message);
      if (attackEvent) {
        if (
          !isTrackablePlayer(attackEvent.attacker) ||
          !isTrackablePlayer(attackEvent.victim)
        ) {
          continue;
        }

        const attackerRecord = upsertPlayer(players, attackEvent.attacker);
        const attackerRoundRecord = upsertRoundPlayer(
          currentRound,
          attackEvent.attacker,
        );

        attackerRecord.damage += attackEvent.damage;
        attackerRoundRecord.damage += attackEvent.damage;

        if (attackEvent.hitgroup === "head" && attackEvent.damage > 0) {
          attackerRecord.headDamage += attackEvent.damage;
          attackerRoundRecord.headDamage += attackEvent.damage;
        }

        continue;
      }

      const utilityThrowEvent = extractUtilityThrowEvent(message);
      if (utilityThrowEvent && isTrackablePlayer(utilityThrowEvent.player)) {
        const playerRecord = upsertPlayer(players, utilityThrowEvent.player);
        const playerRoundRecord = upsertRoundPlayer(
          currentRound,
          utilityThrowEvent.player,
        );

        incrementUtilityStat(
          playerRecord.utilityThrown,
          utilityThrowEvent.utility,
        );
        incrementUtilityStat(
          playerRoundRecord.utilityThrown,
          utilityThrowEvent.utility,
        );
        continue;
      }

      const killEvent = extractKillEvent(message);
      if (killEvent) {
        if (
          !isTrackablePlayer(killEvent.killer) ||
          !isTrackablePlayer(killEvent.victim)
        ) {
          continue;
        }

        const killerRecord = upsertPlayer(players, killEvent.killer);
        const victimRecord = upsertPlayer(players, killEvent.victim);
        const killerRoundRecord = upsertRoundPlayer(
          currentRound,
          killEvent.killer,
        );
        const victimRoundRecord = upsertRoundPlayer(
          currentRound,
          killEvent.victim,
        );
        killerRecord.kills += 1;
        victimRecord.deaths += 1;
        killerRoundRecord.kills += 1;
        victimRoundRecord.deaths += 1;

        if (killEvent.isHeadshot) {
          killerRecord.headshotKills += 1;
          killerRoundRecord.headshotKills += 1;
        }
        continue;
      }

      const assistEvent = extractAssistEvent(message);
      if (assistEvent) {
        if (
          !isTrackablePlayer(assistEvent.assister) ||
          !isTrackablePlayer(assistEvent.victim)
        ) {
          continue;
        }

        // Dont count same side assists (flashes) in stats
        if (
          assistEvent.assister.side &&
          assistEvent.victim.side &&
          assistEvent.assister.side === assistEvent.victim.side
        ) {
          continue;
        }

        const assisterRecord = upsertPlayer(players, assistEvent.assister);
        const assisterRoundRecord = upsertRoundPlayer(
          currentRound,
          assistEvent.assister,
        );

        assisterRecord.assists += 1;
        assisterRoundRecord.assists += 1;

        if (assistEvent.isFlashAssist) {
          assisterRecord.flashAssists += 1;
          assisterRoundRecord.flashAssists += 1;
        }
      }
    }
  }

  if (currentRound) {
    finalizeRound(currentRound, rounds, teamOrganizations, null, false);
  }

  const completedRoundsCount = rounds.filter(
    (round) => round.isComplete,
  ).length;

  const finalizedPlayers = [...players.values()].map((player) => ({
    ...player,
    organization: resolveOrganizationForSide(player.side, teamOrganizations),
    adr: calculateAdr(player.damage, completedRoundsCount),
    headshotPercentage: calculateHeadshotPercentage(
      player.headshotKills,
      player.kills,
    ),
  }));

  return {
    mapName: mapName,
    isComplete,
    finalScore,
    durationMinutes,
    winningSide,
    winningOrganization: resolveOrganizationForSide(
      winningSide,
      teamOrganizations,
    ),
    roster: finalizedPlayers,
    rounds: rounds.map(finalizeRoundRecord),
  };
}

function determineWinningSide(score: RoundScore): Side | null {
  if (score.CT === score.T) {
    return null;
  }

  return score.CT > score.T ? "CT" : "T";
}

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
