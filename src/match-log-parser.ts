type Side = "CT" | "T";

type PlayerRecord = {
  id: string;
  name: string;
  organization: string | null;
  side: Side | null;
  kills: number;
  deaths: number;
  assists: number;
  flashAssists: number;
  flashesThrown: number;
  playersBlinded: number;
  blindDurationSeconds: number;
};

type ParsedTimestamp = {
  raw: string;
  epochMs: number;
  message: string;
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

type TeamScore = {
  CT: number | null;
  T: number | null;
};

type ParseOptions = {
  sourceUrl: string;
};

type PlayerTokenMatch = {
  player: PlayerRef;
  endIndex: number;
};

type KillEvent = {
  killer: PlayerRef;
  victim: PlayerRef;
  extras: string;
};

type AssistEvent = {
  assistant: PlayerRef;
  victim: PlayerRef;
  extras: string;
};

type BlindEvent = {
  thrower: PlayerRef;
  durationSeconds: number;
};

export type MatchLeader = {
  playerId: string;
  name: string;
  organization: string | null;
  value: number;
};

export type MatchRound = {
  round: number;
  startedAt: string | null;
  endedAt: string | null;
  winnerSide: Side | null;
  winnerOrganization: string | null;
  killCount: number;
};

export type MatchPlayerStats = PlayerRecord;

export type MatchReport = {
  sourceUrl: string;
  importedAt: string;
  warnings: string[];
  summary: {
    mapName: string | null;
    startedAt: string | null;
    endedAt: string | null;
    durationSeconds: number;
    durationLabel: string;
    totalRounds: number;
    totalKills: number;
    rawLineCount: number;
    parsedEventCount: number;
    teams: string[];
    finalScore: {
      ct: number | null;
      t: number | null;
    };
  };
  leaders: {
    mostKills: MatchLeader | null;
    mostAssists: MatchLeader | null;
    mostFlashAssists: MatchLeader | null;
  };
  players: MatchPlayerStats[];
  rounds: MatchRound[];
};

export function parseMatchLog(
  rawText: string,
  options: ParseOptions,
): MatchReport {
  const importedAt = new Date().toISOString();
  const warnings = new Set<string>();
  const players = new Map<string, PlayerRecord>();
  const assistEvents = new Set<string>();
  const rounds: MatchRound[] = [];
  const teamOrganizations: TeamOrganizations = { CT: null, T: null };
  const knownOrganizations = new Set<string>();
  const finalScore: TeamScore = { CT: null, T: null };

  let mapName: string | null = null;
  let firstTimestamp: ParsedTimestamp | null = null;
  let lastTimestamp: ParsedTimestamp | null = null;
  let matchStartedAt: ParsedTimestamp | null = null;
  let firstRoundStartedAt: ParsedTimestamp | null = null;
  let lastRoundEndedAt: ParsedTimestamp | null = null;
  let matchEndedAt: ParsedTimestamp | null = null;
  let currentRound: MatchRound | null = null;
  let totalKills = 0;
  let parsedEventCount = 0;

  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const parsedLine = parseTimestampedLine(line);

    if (!parsedLine) {
      continue;
    }

    parsedEventCount += 1;
    firstTimestamp ??= parsedLine;
    lastTimestamp = parsedLine;

    const { message } = parsedLine;

    const detectedMapName = extractMapName(message);
    if (detectedMapName) {
      mapName = detectedMapName;
    }

    const playingTeam = extractTeamPlaying(message);
    if (playingTeam) {
      teamOrganizations[playingTeam.side] = playingTeam.organization;
      knownOrganizations.add(playingTeam.organization);
      applyOrganizationToPlayersWithoutOrg(
        players,
        playingTeam.side,
        playingTeam.organization,
      );
      continue;
    }

    const matchStatus = extractMatchStatus(message);
    if (matchStatus) {
      mapName = matchStatus.mapName ?? mapName;
      finalScore.CT = matchStatus.score.CT;
      finalScore.T = matchStatus.score.T;
      continue;
    }

    const teamScore = extractTeamScore(message);
    if (teamScore) {
      finalScore[teamScore.side] = teamScore.score;
      continue;
    }

    const teamSwitch = extractTeamSwitch(message);
    if (teamSwitch) {
      const playerRecord = upsertPlayer(
        players,
        teamSwitch.player,
        teamOrganizations,
      );
      playerRecord.side = teamSwitch.toSide;
      if (!playerRecord.organization) {
        playerRecord.organization = teamOrganizations[teamSwitch.toSide];
      }
      continue;
    }

    if (isMatchStart(message)) {
      matchStartedAt = parsedLine;
      firstRoundStartedAt = null;
      lastRoundEndedAt = null;
      matchEndedAt = null;
      currentRound = null;
      totalKills = 0;
      finalScore.CT = 0;
      finalScore.T = 0;
      rounds.length = 0;
      assistEvents.clear();
      resetPlayerStats(players);
      continue;
    }

    if (isRoundStart(message)) {
      if (currentRound && !currentRound.endedAt) {
        currentRound.endedAt = parsedLine.raw;
      }

      currentRound = {
        round: rounds.length + 1,
        startedAt: parsedLine.raw,
        endedAt: null,
        winnerSide: null,
        winnerOrganization: null,
        killCount: 0,
      };
      rounds.push(currentRound);
      firstRoundStartedAt ??= parsedLine;
      continue;
    }

    if (isRoundEnd(message)) {
      if (currentRound) {
        currentRound.endedAt = parsedLine.raw;
      }
      lastRoundEndedAt = parsedLine;
      currentRound = null;
      continue;
    }

    if (isGameOver(message)) {
      matchEndedAt = parsedLine;
      if (currentRound && !currentRound.endedAt) {
        currentRound.endedAt = parsedLine.raw;
      }
      continue;
    }

    const winnerSide = extractWinningSide(message);
    if (winnerSide && currentRound) {
      currentRound.winnerSide = winnerSide;
      currentRound.winnerOrganization = teamOrganizations[winnerSide];
      continue;
    }

    const killEvent = extractKillEvent(message);
    if (killEvent) {
      const killerRecord = upsertPlayer(
        players,
        killEvent.killer,
        teamOrganizations,
      );
      const victimRecord = upsertPlayer(
        players,
        killEvent.victim,
        teamOrganizations,
      );

      killerRecord.kills += 1;
      victimRecord.deaths += 1;
      totalKills += 1;

      if (currentRound) {
        currentRound.killCount += 1;
      }

      const directAssist = extractAssistFromKillExtras(killEvent.extras);
      if (directAssist) {
        registerAssist(
          players,
          assistEvents,
          parsedLine.raw,
          directAssist.player,
          killEvent.victim,
          directAssist.flash,
          teamOrganizations,
        );
      }

      continue;
    }

    const assistEvent = extractAssistEvent(message);
    if (assistEvent) {
      registerAssist(
        players,
        assistEvents,
        parsedLine.raw,
        assistEvent.assistant,
        assistEvent.victim,
        isFlashAssist(assistEvent.extras),
        teamOrganizations,
      );
      continue;
    }

    const blindEvent = extractBlindEvent(message);
    if (blindEvent) {
      const throwerRecord = upsertPlayer(
        players,
        blindEvent.thrower,
        teamOrganizations,
      );
      throwerRecord.playersBlinded += 1;
      throwerRecord.blindDurationSeconds += blindEvent.durationSeconds;
      continue;
    }

    const flashThrower = extractFlashThrower(message);
    if (flashThrower) {
      const throwerRecord = upsertPlayer(
        players,
        flashThrower,
        teamOrganizations,
      );
      throwerRecord.flashesThrown += 1;
    }
  }

  const startedAt = matchStartedAt ?? firstRoundStartedAt ?? firstTimestamp;
  const endedAt = matchEndedAt ?? lastRoundEndedAt ?? lastTimestamp;
  const durationSeconds =
    startedAt && endedAt
      ? Math.max(0, Math.floor((endedAt.epochMs - startedAt.epochMs) / 1000))
      : 0;

  if (!mapName) {
    warnings.add("No map name found in log.");
  }

  if (rounds.length === 0) {
    warnings.add("No round boundaries found in log.");
  }

  if (totalKills === 0) {
    warnings.add("No kill events were parsed from the log.");
  }

  if (!matchEndedAt) {
    warnings.add("No explicit game over line was found in the log.");
  }

  const sortedPlayers = [...players.values()].sort((left, right) => {
    return (
      right.kills - left.kills ||
      right.flashAssists - left.flashAssists ||
      right.assists - left.assists ||
      left.name.localeCompare(right.name)
    );
  });

  return {
    sourceUrl: options.sourceUrl,
    importedAt,
    warnings: [...warnings],
    summary: {
      mapName,
      startedAt: startedAt?.raw ?? null,
      endedAt: endedAt?.raw ?? null,
      durationSeconds,
      durationLabel: formatDuration(durationSeconds),
      totalRounds: rounds.length,
      totalKills,
      rawLineCount: lines.length,
      parsedEventCount,
      teams: [...knownOrganizations].sort((left, right) =>
        left.localeCompare(right),
      ),
      finalScore: {
        ct: finalScore.CT,
        t: finalScore.T,
      },
    },
    leaders: {
      mostKills: pickLeader(sortedPlayers, "kills"),
      mostAssists: pickLeader(sortedPlayers, "assists"),
      mostFlashAssists: pickLeader(sortedPlayers, "flashAssists"),
    },
    players: sortedPlayers,
    rounds,
  };
}

function parseTimestampedLine(line: string): ParsedTimestamp | null {
  const normalizedLine = line.startsWith("L ") ? line.slice(2) : line;
  const dateSeparatorIndex = normalizedLine.indexOf(" - ");

  if (dateSeparatorIndex === -1) {
    return null;
  }

  const messageSeparatorIndex = normalizedLine.indexOf(
    ": ",
    dateSeparatorIndex + 11,
  );
  if (messageSeparatorIndex === -1) {
    return null;
  }

  const datePart = normalizedLine.slice(0, dateSeparatorIndex);
  const timePart = normalizedLine.slice(
    dateSeparatorIndex + 3,
    messageSeparatorIndex,
  );
  const message = normalizedLine.slice(messageSeparatorIndex + 2);

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
    raw: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`,
    epochMs: Date.UTC(year, month - 1, day, hour, minute, second),
    message,
  };
}

function extractMapName(message: string): string | null {
  if (message.includes('World triggered "Match_Start" on "')) {
    return extractQuotedValueAfter(
      message,
      'World triggered "Match_Start" on ',
    );
  }

  if (
    message.includes("MatchStatus: Score: ") &&
    message.includes(' on map "')
  ) {
    return extractQuotedValueAfter(message, " on map ");
  }

  if (message.includes('Loading map "')) {
    return extractQuotedValueAfter(message, "Loading map ");
  }

  if (message.includes('Started map "')) {
    return extractQuotedValueAfter(message, "Started map ");
  }

  if (message.includes("changelevel ")) {
    return (
      message
        .slice(message.indexOf("changelevel ") + "changelevel ".length)
        .split(" ")[0] ?? null
    );
  }

  return null;
}

function extractTeamPlaying(
  message: string,
): { side: Side; organization: string } | null {
  const prefix = message.startsWith('MatchStatus: Team playing "')
    ? "MatchStatus: Team playing "
    : null;

  if (!prefix) {
    return null;
  }

  const side = extractQuotedValueAfter(message, prefix);
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

function extractMatchStatus(
  message: string,
): { mapName: string | null; score: TeamScore } | null {
  if (!message.startsWith("MatchStatus: Score: ")) {
    return null;
  }

  const scoreStart = "MatchStatus: Score: ".length;
  const onMapIndex = message.indexOf(' on map "', scoreStart);

  if (onMapIndex === -1) {
    return null;
  }

  const rawScore = message.slice(scoreStart, onMapIndex);
  const [ctScore, tScore] = rawScore
    .split(":")
    .map((value) => Number.parseInt(value, 10));

  return {
    mapName: extractQuotedValueAfter(message, " on map "),
    score: {
      CT: Number.isNaN(ctScore) ? null : ctScore,
      T: Number.isNaN(tScore) ? null : tScore,
    },
  };
}

function extractTeamScore(
  message: string,
): { side: Side; score: number } | null {
  if (!message.startsWith('Team "') || !message.includes(' scored "')) {
    return null;
  }

  const side = extractQuotedValueAfter(message, "Team ");
  const score = extractQuotedValueAfter(message, " scored ");
  const normalizedSide = side ? normalizeSide(side) : null;
  const parsedScore = score ? Number.parseInt(score, 10) : Number.NaN;

  if (!normalizedSide || Number.isNaN(parsedScore)) {
    return null;
  }

  return {
    side: normalizedSide,
    score: parsedScore,
  };
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

function isMatchStart(message: string): boolean {
  return (
    message.includes('World triggered "Game_Commencing"') ||
    message.includes('World triggered "Match_Start"')
  );
}

function isRoundStart(message: string): boolean {
  return message.includes('World triggered "Round_Start"');
}

function isRoundEnd(message: string): boolean {
  return message.includes('World triggered "Round_End"');
}

function isGameOver(message: string): boolean {
  return message.startsWith("Game Over: ");
}

function extractWinningSide(message: string): Side | null {
  if (!message.startsWith('Team "') || !message.includes(' triggered "')) {
    return null;
  }

  const side = extractQuotedValueAfter(message, "Team ");
  const event = extractQuotedValueAfter(message, " triggered ");

  if (!side || !event || !event.toLowerCase().includes("win")) {
    return null;
  }

  return normalizeSide(side);
}

function extractKillEvent(message: string): KillEvent | null {
  const killerMatch = extractPlayerTokenAtStart(message);

  if (!killerMatch) {
    return null;
  }

  const killMarker = " killed ";
  const killIndex = message.indexOf(killMarker, killerMatch.endIndex);

  if (killIndex === -1 || !message.includes(' with "')) {
    return null;
  }

  const victimMatch = extractNextPlayerToken(
    message,
    killIndex + killMarker.length,
  );

  if (!victimMatch) {
    return null;
  }

  const weaponIndex = message.indexOf(' with "', victimMatch.endIndex);

  if (weaponIndex === -1) {
    return null;
  }

  return {
    killer: killerMatch.player,
    victim: victimMatch.player,
    extras: message.slice(weaponIndex),
  };
}

function extractAssistEvent(message: string): AssistEvent | null {
  const assistantMatch = extractPlayerTokenAtStart(message);

  if (!assistantMatch) {
    return null;
  }

  const assistMarker = " assisted killing ";
  const assistIndex = message.indexOf(assistMarker, assistantMatch.endIndex);

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
    assistant: assistantMatch.player,
    victim: victimMatch.player,
    extras: message.slice(victimMatch.endIndex),
  };
}

function extractBlindEvent(message: string): BlindEvent | null {
  const victimMatch = extractPlayerTokenAtStart(message);

  if (!victimMatch) {
    return null;
  }

  const blindIndex = message.indexOf(" blinded", victimMatch.endIndex);
  const byIndex = message.indexOf(" by ", blindIndex);

  if (blindIndex === -1 || byIndex === -1) {
    return null;
  }

  const throwerMatch = extractNextPlayerToken(message, byIndex + 4);

  if (!throwerMatch) {
    return null;
  }

  const blindDetails = message.slice(blindIndex, byIndex);
  const durationMarker = "blinded for ";
  const durationIndex = blindDetails.indexOf(durationMarker);

  let durationSeconds = 0;

  if (durationIndex !== -1) {
    const durationText =
      blindDetails.slice(durationIndex + durationMarker.length).split(" ")[0] ??
      "0";
    durationSeconds = Number.parseFloat(durationText) || 0;
  }

  return {
    thrower: throwerMatch.player,
    durationSeconds,
  };
}

function extractFlashThrower(message: string): PlayerRef | null {
  const isFlashEvent =
    message.includes(' triggered "flashbang_detonate"') ||
    message.includes(" threw flashbang ");

  if (!isFlashEvent) {
    return null;
  }

  return extractPlayerTokenAtStart(message)?.player ?? null;
}

function extractAssistFromKillExtras(
  extras: string,
): { player: PlayerRef; flash: boolean } | null {
  const flashAssist = extractPlayerAfterMarker(extras, "flash-assisted by ");
  if (flashAssist) {
    return {
      player: flashAssist,
      flash: true,
    };
  }

  const flashbangAssist = extractPlayerAfterMarker(
    extras,
    "assisted by flashbang from ",
  );
  if (flashbangAssist) {
    return {
      player: flashbangAssist,
      flash: true,
    };
  }

  const standardAssist = extractPlayerAfterMarker(extras, "assisted by ");
  if (standardAssist) {
    return {
      player: standardAssist,
      flash: false,
    };
  }

  return null;
}

function isFlashAssist(extras: string): boolean {
  return extras.toLowerCase().includes("flash");
}

function extractPlayerAfterMarker(
  text: string,
  marker: string,
): PlayerRef | null {
  const markerIndex = text.indexOf(marker);

  if (markerIndex === -1) {
    return null;
  }

  return (
    extractNextPlayerToken(text, markerIndex + marker.length)?.player ?? null
  );
}

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

function upsertPlayer(
  players: Map<string, PlayerRecord>,
  player: PlayerRef,
  teamOrganizations: TeamOrganizations,
): PlayerRecord {
  const existing = players.get(player.key);
  const organization = player.side ? teamOrganizations[player.side] : null;

  if (existing) {
    existing.name = player.name;

    if (player.side) {
      existing.side = player.side;
    }

    if (!existing.organization && organization) {
      existing.organization = organization;
    }

    return existing;
  }

  const created: PlayerRecord = {
    id: player.key,
    name: player.name,
    organization,
    side: player.side,
    kills: 0,
    deaths: 0,
    assists: 0,
    flashAssists: 0,
    flashesThrown: 0,
    playersBlinded: 0,
    blindDurationSeconds: 0,
  };

  players.set(player.key, created);
  return created;
}

function applyOrganizationToPlayersWithoutOrg(
  players: Map<string, PlayerRecord>,
  side: Side,
  organization: string,
): void {
  for (const player of players.values()) {
    if (player.side === side && !player.organization) {
      player.organization = organization;
    }
  }
}

function resetPlayerStats(players: Map<string, PlayerRecord>): void {
  for (const player of players.values()) {
    player.kills = 0;
    player.deaths = 0;
    player.assists = 0;
    player.flashAssists = 0;
    player.flashesThrown = 0;
    player.playersBlinded = 0;
    player.blindDurationSeconds = 0;
  }
}

function registerAssist(
  players: Map<string, PlayerRecord>,
  assistEvents: Set<string>,
  timestamp: string,
  assistant: PlayerRef,
  victim: PlayerRef,
  flash: boolean,
  teamOrganizations: TeamOrganizations,
): void {
  const signature = `${timestamp}:${assistant.key}:${victim.key}:${flash ? "flash" : "standard"}`;

  if (assistEvents.has(signature)) {
    return;
  }

  assistEvents.add(signature);
  const assistantRecord = upsertPlayer(players, assistant, teamOrganizations);
  assistantRecord.assists += 1;

  if (flash) {
    assistantRecord.flashAssists += 1;
  }
}

function pickLeader(
  players: PlayerRecord[],
  key: keyof Pick<PlayerRecord, "kills" | "assists" | "flashAssists">,
): MatchLeader | null {
  const leader = [...players].sort((left, right) => {
    return (
      right[key] - left[key] ||
      right.kills - left.kills ||
      right.assists - left.assists ||
      left.name.localeCompare(right.name)
    );
  })[0];

  if (!leader || leader[key] === 0) {
    return null;
  }

  return {
    playerId: leader.id,
    name: leader.name,
    organization: leader.organization,
    value: leader[key],
  };
}

function extractQuotedValueAfter(text: string, marker: string): string | null {
  const markerIndex = text.indexOf(marker);

  if (markerIndex === -1) {
    return null;
  }

  const quoteIndex = text.indexOf('"', markerIndex + marker.length);

  if (quoteIndex === -1) {
    return null;
  }

  const closingQuoteIndex = text.indexOf('"', quoteIndex + 1);

  if (closingQuoteIndex === -1) {
    return null;
  }

  return text.slice(quoteIndex + 1, closingQuoteIndex);
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

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
