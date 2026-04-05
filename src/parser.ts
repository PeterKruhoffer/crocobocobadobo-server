import { parseLineIntoParts } from "./parser-core";
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
} from "./parser-events";
import { MatchAccumulator } from "./parser-state/MatchAccumulator";
import type { ParsedLogResponse } from "./parser-types";

export type {
  BombSite,
  DerivedRoundWinReason,
  ParsedLogResponse,
  RoundPlayerIdentity,
  RoundScore,
  RoundSummary,
  RoundWinReason,
  UtilityStats,
} from "./parser-types";

export function parseMatchLog(log: string): ParsedLogResponse | null {
  const accumulator = new MatchAccumulator();

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
      accumulator.recordGameOver(gameOver);
      break;
    }

    const roundsPlayed = extractRoundsPlayed(message);
    if (roundsPlayed !== null) {
      accumulator.noteRoundsPlayed(roundsPlayed);
    }

    const score = extractScore(message);
    if (score) {
      accumulator.applyScore(score);
    }

    if (isRoundEnd(message)) {
      accumulator.handleRoundEnd(parsedLine.timeStamp);
      continue;
    }

    if (isRoundRestart(message)) {
      accumulator.handleRoundRestart(parsedLine.timeStamp);
      continue;
    }

    const roundOutcome = extractRoundOutcome(message);
    if (roundOutcome && accumulator.applyRoundOutcome(roundOutcome)) {
      continue;
    }

    const bombPlantEvent = extractBombPlantEvent(message);
    if (bombPlantEvent && accumulator.applyBombPlant(bombPlantEvent)) {
      continue;
    }

    const bombDefuseEvent = extractBombDefuseEvent(message);
    if (bombDefuseEvent && accumulator.applyBombDefuse(bombDefuseEvent)) {
      continue;
    }

    if (isRoundStart(message)) {
      accumulator.startRound(parsedLine.timeStamp);
      continue;
    }

    const utilityPurchaseEvent = extractUtilityPurchaseEvent(message);
    if (
      utilityPurchaseEvent &&
      accumulator.applyUtilityPurchase(utilityPurchaseEvent)
    ) {
      continue;
    }

    const team = extractTeamPlaying(message);
    if (team) {
      accumulator.setTeamPlaying(team);
      continue;
    }

    const teamSwitch = extractTeamSwitch(message);
    if (teamSwitch) {
      accumulator.applyTeamSwitch(teamSwitch);
      continue;
    }

    if (accumulator.isRoundLive()) {
      const attackEvent = extractAttackEvent(message);
      if (attackEvent && accumulator.applyAttack(attackEvent)) {
        continue;
      }

      const utilityThrowEvent = extractUtilityThrowEvent(message);
      if (
        utilityThrowEvent &&
        accumulator.applyUtilityThrow(utilityThrowEvent)
      ) {
        continue;
      }

      const killEvent = extractKillEvent(message);
      if (killEvent && accumulator.applyKill(killEvent)) {
        continue;
      }

      const assistEvent = extractAssistEvent(message);
      if (assistEvent && accumulator.applyAssist(assistEvent)) {
        continue;
      }
    }
  }

  return accumulator.finish();
}
