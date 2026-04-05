import { parseLineIntoParts } from "./parser-core";
import { recognizeParserEvents } from "./parser-events";
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

    const events = recognizeParserEvents(parsedLine.message);
    if (events.length === 0) {
      continue;
    }

    for (const event of events) {
      const isGameOver = accumulator.applyEvent(event, parsedLine.timeStamp);
      if (isGameOver) {
        return accumulator.finish();
      }
    }
  }

  return accumulator.finish();
}
