export type ParsedLogResponse = {
  mapName: string | null;
  roster: {
    organization: string | null;
    id: string;
    name: string;
    side: Side | null;
    kills: number;
    deaths: number;
    assists: number;
    flashAssists: number;
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
  }[];
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

export type BombSite = "A" | "B";

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
  let hasLiveMatchStarted = false;
  let isRoundLive = false;
  let latestRoundsPlayed: number | null = null;
  let currentRound: RoundRecord | null = null;
  const players = new Map<string, PlayerRecord>();
  const rounds: RoundRecord[] = [];
  const teamOrganizations: TeamOrganizations = { CT: null, T: null };

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

    const detectedMapName = extractMapName(message);
    if (detectedMapName) {
      mapName = detectedMapName;
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

  const finalizedPlayers = [...players.values()].map((player) => ({
    ...player,
    organization: resolveOrganizationForSide(player.side, teamOrganizations),
  }));

  return {
    mapName: mapName,
    roster: finalizedPlayers,
    rounds: rounds.map(finalizeRoundRecord),
  };
}

type ParsedParts = {
  timeStamp: string;
  epochMs: number;
  message: string;
};

/**
 * Parses a line into 3 parts
 * 1. Normalized timestamp eg. 2021-11-28 20:41:48
 * 2. Timestamp in Unix epoch milliseconds, used in later calculations
 * 3. message: what happened in the game at that time (Game event)
 **/
function parseLineIntoParts(line: string): ParsedParts | null {
  const dateSeparatorIndex = line.indexOf(" - ");

  if (dateSeparatorIndex === -1) {
    return null;
  }

  const messageSeparatorIndex = line.indexOf(": ", dateSeparatorIndex + 11);
  if (messageSeparatorIndex === -1) {
    return null;
  }

  const datePart = line.slice(0, dateSeparatorIndex);
  const timePart = line.slice(dateSeparatorIndex + 3, messageSeparatorIndex);
  const message = line.slice(messageSeparatorIndex + 2);

  const datePieces = datePart.split("/");
  const timePieces = timePart.split(":");

  if (datePieces.length !== 3 || timePieces.length !== 3) {
    return null;
  }

  const month = Number.parseInt(datePieces[0], 10);
  const day = Number.parseInt(datePieces[1], 10);
  const year = Number.parseInt(datePieces[2], 10);
  const hour = Number.parseInt(timePieces[0], 10);
  const minute = Number.parseInt(timePieces[1], 10);
  const second = Number.parseInt(timePieces[2], 10);

  if (
    [month, day, year, hour, minute, second].some((value) =>
      Number.isNaN(value),
    )
  ) {
    return null;
  }

  return {
    timeStamp: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`,
    epochMs: Date.UTC(year, month - 1, day, hour, minute, second),
    message,
  };
}

function extractQuotedValue(text: string, marker: string): string | null {
  const markerIndex = text.indexOf(marker);

  if (markerIndex === -1) {
    return null;
  }

  const quoteIndex = text.indexOf('"', markerIndex + marker.length);

  if (quoteIndex === -1) {
    return null;
  }

  // When we have the first quote we can use that to get the position of the end quote
  const closingQuoteIndex = text.indexOf('"', quoteIndex + 1);

  if (closingQuoteIndex === -1) {
    return null;
  }

  return text.slice(quoteIndex + 1, closingQuoteIndex);
}

function extractMapName(message: string): string | null {
  if (message.includes('World triggered "Match_Start" on "')) {
    return extractQuotedValue(message, 'World triggered "Match_Start" on ');
  }

  if (
    message.includes("MatchStatus: Score: ") &&
    message.includes(' on map "')
  ) {
    return extractQuotedValue(message, " on map ");
  }

  return null;
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
  const match = message.match(/MatchStatus: Score: (\d+):(\d+) on map /);

  if (!match) {
    return null;
  }

  const ctScore = Number.parseInt(match[1], 10);
  const tScore = Number.parseInt(match[2], 10);

  if (Number.isNaN(ctScore) || Number.isNaN(tScore)) {
    return null;
  }

  return {
    CT: ctScore,
    T: tScore,
  };
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

type Side = "CT" | "T";

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
};

type RoundPlayerRecord = {
  id: string;
  name: string;
  side: Side | null;
  kills: number;
  deaths: number;
  assists: number;
  flashAssists: number;
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

type PlayerRef = {
  key: string;
  name: string;
  side: Side | null;
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

type PlayerTokenMatch = {
  player: PlayerRef;
  endIndex: number;
};

function extractPlayerTokenAtStart(text: string): PlayerTokenMatch | null {
  return extractNextPlayerToken(text, 0);
}

function extractNextPlayerToken(
  text: string,
  startIndex: number,
): PlayerTokenMatch | null {
  const quoteIndex = text.indexOf('"', startIndex);

  if (quoteIndex === -1) {
    return null;
  }

  const closingQuoteIndex = text.indexOf('"', quoteIndex + 1);

  if (closingQuoteIndex === -1) {
    return null;
  }

  const token = text.slice(quoteIndex + 1, closingQuoteIndex);
  const player = parsePlayerToken(token);

  if (!player) {
    return null;
  }

  return {
    player,
    endIndex: closingQuoteIndex + 1,
  };
}

function parsePlayerToken(token: string): PlayerRef | null {
  const segments: string[] = [];
  let cursor = token.length - 1;

  while (cursor >= 0 && token[cursor] === ">") {
    const openIndex = token.lastIndexOf("<", cursor);

    if (openIndex === -1) {
      return null;
    }

    segments.unshift(token.slice(openIndex + 1, cursor));
    cursor = openIndex - 1;

    if (segments.length === 3) {
      break;
    }
  }

  if (segments.length < 2) {
    return null;
  }

  const name = token.slice(0, cursor + 1);
  const slot = segments[0];
  const steamId = segments[1];
  const side = normalizeSide(segments[2] ?? "");
  const key = steamId && steamId !== "BOT" ? steamId : `${name}:${slot}`;

  return {
    key,
    name,
    side,
  };
}

function normalizeSide(value: string): Side | null {
  const normalized = value.trim().toUpperCase();

  if (normalized === "CT" || normalized === "COUNTER-TERRORIST") {
    return "CT";
  }

  if (normalized === "T" || normalized === "TERRORIST") {
    return "T";
  }

  return null;
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
): { killer: PlayerRef; victim: PlayerRef } | null {
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
