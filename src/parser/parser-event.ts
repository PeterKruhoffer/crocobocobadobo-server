import {
  convertStringPurchaseToUtilityName,
  extractNextPlayerToken,
  extractPlayerTokenAtStart,
  extractQuotedNumber,
  extractQuotedValue,
  normalizeSide,
  normalizeThrownUtilityName,
  type PlayerRef,
  type UtilityName,
} from "./parser-core";
import type {
  BombSite,
  RoundScore,
  RoundWinReason,
  Side,
} from "./parser-types";

export type ParserEvent =
  | {
      type: "game_over";
      gameOver: { mapName: string; score: RoundScore; durationMinutes: number };
    }
  | { type: "rounds_played"; roundsPlayed: number }
  | { type: "score"; score: RoundScore }
  | { type: "round_end" }
  | { type: "round_restart" }
  | {
      type: "round_outcome";
      roundOutcome: { winningSide: Side | null; reason: RoundWinReason };
    }
  | {
      type: "bomb_plant";
      bombPlant: { player: PlayerRef; site: BombSite | null };
    }
  | { type: "bomb_defuse"; bombDefuse: { player: PlayerRef } }
  | { type: "round_start" }
  | {
      type: "utility_purchase";
      utilityPurchase: { player: PlayerRef; utility: UtilityName };
    }
  | {
      type: "team_playing";
      team: { side: Side; organization: string };
    }
  | {
      type: "team_switch";
      teamSwitch: { player: PlayerRef; toSide: Side };
    }
  | {
      type: "attack";
      attack: {
        attacker: PlayerRef;
        victim: PlayerRef;
        damage: number;
        hitgroup: string | null;
      };
    }
  | {
      type: "utility_throw";
      utilityThrow: { player: PlayerRef; utility: UtilityName };
    }
  | {
      type: "kill";
      kill: { killer: PlayerRef; victim: PlayerRef; isHeadshot: boolean };
    }
  | {
      type: "assist";
      assist: {
        assister: PlayerRef;
        victim: PlayerRef;
        isFlashAssist: boolean;
      };
    };

export function recognizeParserEvents(message: string): ParserEvent[] {
  const events: ParserEvent[] = [];

  const gameOver = extractGameOver(message);
  if (gameOver) {
    return [
      {
        type: "game_over",
        gameOver,
      },
    ];
  }

  const roundsPlayed = extractRoundsPlayed(message);
  if (roundsPlayed !== null) {
    events.push({
      type: "rounds_played",
      roundsPlayed,
    });
  }

  const score = extractScore(message);
  if (score) {
    events.push({
      type: "score",
      score,
    });
  }

  const primaryEvent = recognizePrimaryParserEvent(message);
  if (primaryEvent) {
    events.push(primaryEvent);
  }

  return events;
}

function recognizePrimaryParserEvent(message: string): ParserEvent | null {
  if (isRoundEnd(message)) {
    return { type: "round_end" };
  }

  if (isRoundRestart(message)) {
    return { type: "round_restart" };
  }

  const roundOutcome = extractRoundOutcome(message);
  if (roundOutcome) {
    return {
      type: "round_outcome",
      roundOutcome,
    };
  }

  const bombPlant = extractBombPlantEvent(message);
  if (bombPlant) {
    return {
      type: "bomb_plant",
      bombPlant,
    };
  }

  const bombDefuse = extractBombDefuseEvent(message);
  if (bombDefuse) {
    return {
      type: "bomb_defuse",
      bombDefuse,
    };
  }

  if (isRoundStart(message)) {
    return { type: "round_start" };
  }

  const utilityPurchase = extractUtilityPurchaseEvent(message);
  if (utilityPurchase) {
    return {
      type: "utility_purchase",
      utilityPurchase,
    };
  }

  const team = extractTeamPlaying(message);
  if (team) {
    return {
      type: "team_playing",
      team,
    };
  }

  const teamSwitch = extractTeamSwitch(message);
  if (teamSwitch) {
    return {
      type: "team_switch",
      teamSwitch,
    };
  }

  const attack = extractAttackEvent(message);
  if (attack) {
    return {
      type: "attack",
      attack,
    };
  }

  const utilityThrow = extractUtilityThrowEvent(message);
  if (utilityThrow) {
    return {
      type: "utility_throw",
      utilityThrow,
    };
  }

  const kill = extractKillEvent(message);
  if (kill) {
    return {
      type: "kill",
      kill,
    };
  }

  const assist = extractAssistEvent(message);
  if (assist) {
    return {
      type: "assist",
      assist,
    };
  }

  return null;
}

export function extractGameOver(
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

  // In future do this in a less error prone way!
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

export function extractRoundsPlayed(message: string): number | null {
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

export function extractScore(message: string): RoundScore | null {
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

export function isRoundStart(message: string): boolean {
  return message === 'World triggered "Round_Start"';
}

export function isRoundEnd(message: string): boolean {
  return message === 'World triggered "Round_End"';
}

export function isRoundRestart(message: string): boolean {
  return message.startsWith('World triggered "Restart_Round_');
}

export function extractTeamPlaying(
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

export function extractRoundOutcome(
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

export function extractBombPlantEvent(
  message: string,
): { player: PlayerRef; site: BombSite | null } | null {
  const playerMatch = extractPlayerTokenAtStart(message);

  if (!playerMatch) {
    return null;
  }

  // Make sure this is in fact a bomb plant event
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

export function extractBombDefuseEvent(
  message: string,
): { player: PlayerRef } | null {
  const playerMatch = extractPlayerTokenAtStart(message);

  if (!playerMatch) {
    return null;
  }

  const defuseMarker = ' triggered "Defused_The_Bomb"';
  const defuseIndex = message.indexOf(defuseMarker, playerMatch.endIndex);
  if (defuseIndex === -1) {
    return null;
  }

  return {
    player: playerMatch.player,
  };
}

export function extractTeamSwitch(
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

export function extractKillEvent(
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

export function extractAttackEvent(message: string): {
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

export function extractAssistEvent(
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

export function extractUtilityPurchaseEvent(
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

export function extractUtilityThrowEvent(
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

function extractBombSite(message: string): BombSite | null {
  if (message.endsWith("at bombsite A")) {
    return "A";
  }

  if (message.endsWith("at bombsite B")) {
    return "B";
  }

  return null;
}
