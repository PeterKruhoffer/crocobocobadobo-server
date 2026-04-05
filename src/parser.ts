import {
  convertStringPurchaseToUtilityName,
  extractNextPlayerToken,
  extractPlayerTokenAtStart,
  extractQuotedNumber,
  extractQuotedValue,
  normalizeSide,
  normalizeThrownUtilityName,
  parseLineIntoParts,
  type BombSite as ParserCoreBombSite,
  type PlayerRef,
  type Side,
  type UtilityName,
} from "./parser-core";

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

export type RoundWinReason =
  | "bomb_defused"
  | "bomb_exploded"
  | "cts_win"
  | "terrorists_win";

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

export type RoundScore = {
  CT: number;
  T: number;
};

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

function extractGameOver(
  message: string,
): { mapName: string; score: RoundScore; durationMinutes: number } | null {
  const prefix = "Game Over: competitive ";

  if (!message.startsWith(prefix)) {
    return null;
  }

  const details = message.slice(prefix.length);
  const segments = details.split(" ");

  if (segments.length !== 7) {
    return null;
  }

  const [
    matchId,
    mapName,
    scoreLabel,
    scoreValue,
    afterLabel,
    durationValue,
    durationUnit,
  ] = segments;

  if (
    !matchId ||
    !mapName ||
    scoreLabel !== "score" ||
    !scoreValue ||
    afterLabel !== "after" ||
    !durationValue ||
    durationUnit !== "min"
  ) {
    return null;
  }

  const scoreSeparatorIndex = scoreValue.indexOf(":");

  if (scoreSeparatorIndex === -1) {
    return null;
  }

  const ctScore = Number.parseInt(scoreValue.slice(0, scoreSeparatorIndex), 10);
  const tScore = Number.parseInt(scoreValue.slice(scoreSeparatorIndex + 1), 10);
  const durationMinutes = Number.parseInt(durationValue, 10);

  if (
    Number.isNaN(ctScore) ||
    Number.isNaN(tScore) ||
    Number.isNaN(durationMinutes)
  ) {
    return null;
  }

  return {
    mapName,
    score: {
      CT: ctScore,
      T: tScore,
    },
    durationMinutes,
  };
}

function extractRoundsPlayed(message: string): number | null {
  const marker = "RoundsPlayed: ";
  const markerIndex = message.indexOf(marker);

  if (markerIndex === -1) {
    return null;
  }

  const roundsPlayed = Number.parseInt(
    message.slice(markerIndex + marker.length).trim(),
    10,
  );

  return Number.isNaN(roundsPlayed) ? null : roundsPlayed;
}

function extractScore(message: string): RoundScore | null {
  const prefix = "MatchStatus: Score: ";
  const suffix = " on map ";

  if (!message.startsWith(prefix)) {
    return null;
  }

  const suffixIndex = message.indexOf(suffix, prefix.length);

  if (suffixIndex === -1) {
    return null;
  }

  const scoreValue = message.slice(prefix.length, suffixIndex).trim();
  const scoreSeparatorIndex = scoreValue.indexOf(":");

  if (scoreSeparatorIndex === -1) {
    return null;
  }

  const ctScore = Number.parseInt(scoreValue.slice(0, scoreSeparatorIndex), 10);
  const tScore = Number.parseInt(scoreValue.slice(scoreSeparatorIndex + 1), 10);

  if (Number.isNaN(ctScore) || Number.isNaN(tScore)) {
    return null;
  }

  return {
    CT: ctScore,
    T: tScore,
  };
}

function determineWinningSide(score: RoundScore): Side | null {
  if (score.CT === score.T) {
    return null;
  }

  return score.CT > score.T ? "CT" : "T";
}

function isRoundStart(message: string): boolean {
  return message === 'World triggered "Round_Start"';
}

function isRoundEnd(message: string): boolean {
  return message === 'World triggered "Round_End"';
}

function isRoundRestart(message: string): boolean {
  return message.startsWith('World triggered "Restart_Round_');
}

function extractTeamPlaying(
  message: string,
): { side: Side; organization: string } | null {
  const prefix = message.startsWith('MatchStatus: Team playing "')
    ? "MatchStatus: Team playing "
    : message.startsWith('Team playing "')
      ? "Team playing "
      : null;

  if (!prefix) {
    return null;
  }

  const side = extractQuotedValue(message, prefix);
  const colonIndex = message.indexOf(": ", prefix.length + 1);

  if (!side || colonIndex === -1) {
    return null;
  }

  const normalizedSide = normalizeSide(side);
  const organization = message.slice(colonIndex + 2).trim();

  if (!normalizedSide || !organization) {
    return null;
  }

  return {
    side: normalizedSide,
    organization,
  };
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

function extractRoundOutcome(
  message: string,
): { winningSide: Side | null; reason: RoundWinReason } | null {
  const notice = extractQuotedValue(message, " triggered ");

  if (!notice?.startsWith("SFUI_Notice_")) {
    return null;
  }

  switch (notice) {
    case "SFUI_Notice_Bomb_Defused":
      return { winningSide: "CT", reason: "bomb_defused" };
    case "SFUI_Notice_Target_Bombed":
      return { winningSide: "T", reason: "bomb_exploded" };
    case "SFUI_Notice_CTs_Win":
      return { winningSide: "CT", reason: "cts_win" };
    case "SFUI_Notice_Terrorists_Win":
      return { winningSide: "T", reason: "terrorists_win" };
    default:
      return null;
  }
}

function extractBombPlantEvent(
  message: string,
): { player: PlayerRef; site: BombSite | null } | null {
  const playerMatch = extractPlayerTokenAtStart(message);

  if (!playerMatch) {
    return null;
  }

  const plantMarker = ' triggered "Planted_The_Bomb"';
  const plantIndex = message.indexOf(plantMarker, playerMatch.endIndex);

  if (plantIndex === -1) {
    return null;
  }

  return {
    player: playerMatch.player,
    site: extractBombSite(message),
  };
}

function extractBombDefuseEvent(message: string): { player: PlayerRef } | null {
  const playerMatch = extractPlayerTokenAtStart(message);

  if (!playerMatch) {
    return null;
  }

  return message.includes(' triggered "Defused_The_Bomb"')
    ? { player: playerMatch.player }
    : null;
}

function extractBombSite(message: string): BombSite | null {
  if (message.endsWith("at bombsite A")) {
    return "A";
  }

  if (message.endsWith("at bombsite B")) {
    return "B";
  }

  return null;
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

function extractTeamSwitch(
  message: string,
): { player: PlayerRef; toSide: Side } | null {
  const playerMatch = extractPlayerTokenAtStart(message);

  if (!playerMatch) {
    return null;
  }

  const switchMarker = " switched from team <";
  const switchIndex = message.indexOf(switchMarker, playerMatch.endIndex);

  if (switchIndex === -1) {
    return null;
  }

  const toSideMarker = "> to <";
  const toSideIndex = message.indexOf(
    toSideMarker,
    switchIndex + switchMarker.length,
  );
  const closingIndex = message.indexOf(">", toSideIndex + toSideMarker.length);

  if (toSideIndex === -1 || closingIndex === -1) {
    return null;
  }

  const toSide = normalizeSide(
    message.slice(toSideIndex + toSideMarker.length, closingIndex),
  );

  if (!toSide) {
    return null;
  }

  return {
    player: {
      ...playerMatch.player,
      side: toSide,
    },
    toSide,
  };
}

function extractKillEvent(
  message: string,
): { killer: PlayerRef; victim: PlayerRef; isHeadshot: boolean } | null {
  const killerMatch = extractPlayerTokenAtStart(message);

  if (!killerMatch) {
    return null;
  }

  const killMarker = " killed ";
  const killIndex = message.indexOf(killMarker, killerMatch.endIndex);

  if (killIndex === -1) {
    return null;
  }

  if (message.startsWith('other "', killIndex + killMarker.length)) {
    return null;
  }

  const victimMatch = extractNextPlayerToken(
    message,
    killIndex + killMarker.length,
  );

  if (!victimMatch) {
    return null;
  }

  return {
    killer: killerMatch.player,
    victim: victimMatch.player,
    isHeadshot: message.includes("(headshot)"),
  };
}

function extractAttackEvent(message: string): {
  attacker: PlayerRef;
  victim: PlayerRef;
  damage: number;
  hitgroup: string | null;
} | null {
  const attackerMatch = extractPlayerTokenAtStart(message);

  if (!attackerMatch) {
    return null;
  }

  const attackMarker = " attacked ";
  const attackIndex = message.indexOf(attackMarker, attackerMatch.endIndex);

  if (attackIndex === -1) {
    return null;
  }

  if (message.startsWith('other "', attackIndex + attackMarker.length)) {
    return null;
  }

  const victimMatch = extractNextPlayerToken(
    message,
    attackIndex + attackMarker.length,
  );

  if (!victimMatch) {
    return null;
  }

  const damage = extractQuotedNumber(message, "(damage ");

  if (damage === null) {
    return null;
  }

  return {
    attacker: attackerMatch.player,
    victim: victimMatch.player,
    damage,
    hitgroup: extractQuotedValue(message, "(hitgroup "),
  };
}

function extractAssistEvent(
  message: string,
): { assister: PlayerRef; victim: PlayerRef; isFlashAssist: boolean } | null {
  const assisterMatch = extractPlayerTokenAtStart(message);

  if (!assisterMatch) {
    return null;
  }

  const isFlashAssist = message.includes(" flash-assisted killing ");
  const assistMarker = isFlashAssist
    ? " flash-assisted killing "
    : message.includes(" assisted killing ")
      ? " assisted killing "
      : null;

  if (!assistMarker) {
    return null;
  }

  const assistIndex = message.indexOf(assistMarker, assisterMatch.endIndex);

  if (assistIndex === -1) {
    return null;
  }

  const victimMatch = extractNextPlayerToken(
    message,
    assistIndex + assistMarker.length,
  );

  if (!victimMatch) {
    return null;
  }

  return {
    assister: assisterMatch.player,
    victim: victimMatch.player,
    isFlashAssist,
  };
}

function extractUtilityPurchaseEvent(
  message: string,
): { player: PlayerRef; utility: UtilityName } | null {
  const playerMatch = extractPlayerTokenAtStart(message);

  if (!playerMatch) {
    return null;
  }

  const purchased = extractQuotedValue(message, " purchased ");
  const utility = purchased
    ? convertStringPurchaseToUtilityName(purchased)
    : null;

  if (!utility) {
    return null;
  }

  return {
    player: playerMatch.player,
    utility,
  };
}

function extractUtilityThrowEvent(
  message: string,
): { player: PlayerRef; utility: UtilityName } | null {
  const playerMatch = extractPlayerTokenAtStart(message);

  if (!playerMatch) {
    return null;
  }

  const throwMarker = " threw ";
  const throwIndex = message.indexOf(throwMarker, playerMatch.endIndex);

  if (throwIndex === -1) {
    return null;
  }

  const utilityEndIndex = message.indexOf(" ", throwIndex + throwMarker.length);
  const utilityToken =
    utilityEndIndex === -1
      ? message.slice(throwIndex + throwMarker.length)
      : message.slice(throwIndex + throwMarker.length, utilityEndIndex);
  const utility = normalizeThrownUtilityName(
    utilityToken,
    playerMatch.player.side,
  );

  if (!utility) {
    return null;
  }

  return {
    player: playerMatch.player,
    utility,
  };
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
