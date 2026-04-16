import { Side } from "./parser-types";

export type ParsedParts = {
  timeStamp: string;
  epochMs: number;
  message: string;
};

export type UtilityName =
  | "flashbang"
  | "molotov"
  | "incgrenade"
  | "smokegrenade"
  | "hegrenade";

export type PlayerRef = {
  key: string;
  name: string;
  side: Side | null;
};

export type PlayerTokenMatch = {
  player: PlayerRef;
  endIndex: number;
};

/**
 * Parses a line into 3 parts
 * 1. Normalized timestamp eg. 2021-11-28 20:41:48
 * 2. Timestamp in Unix epoch milliseconds, used in later calculations
 * 3. message: what happened in the game at that time (Game event)
 **/
export function parseLineIntoParts(line: string): ParsedParts | null {
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

  // Since the data is in a stable format we can index safely(99% safe lol) here
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

export function extractQuotedValue(
  text: string,
  marker: string,
): string | null {
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

export function extractQuotedNumber(
  text: string,
  marker: string,
): number | null {
  const value = extractQuotedValue(text, marker);

  if (value === null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export function extractPlayerTokenAtStart(
  text: string,
): PlayerTokenMatch | null {
  return extractNextPlayerToken(text, 0);
}

export function extractNextPlayerToken(
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

export function parsePlayerToken(token: string): PlayerRef | null {
  const segments: string[] = [];
  let cursor = token.length - 1;

  while (cursor >= 0 && token[cursor] === ">") {
    const openIndex = token.lastIndexOf("<", cursor);

    if (openIndex === -1) {
      return null;
    }

    segments.unshift(token.slice(openIndex + 1, cursor));
    cursor = openIndex - 1;

    // we break on 3 due to wanting side, steamId and slot
    // once we have those we are done
    if (segments.length === 3) {
      break;
    }
  }

  if (segments.length < 2) {
    return null;
  }

  // Extracting slot and using it only for the fallback key might me overkill
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

export function normalizeSide(value: string): Side | null {
  const normalized = value.trim().toUpperCase();

  if (normalized === "CT" || normalized === "COUNTER-TERRORIST") {
    return "CT";
  }

  if (normalized === "T" || normalized === "TERRORIST") {
    return "T";
  }

  return null;
}

export function convertStringPurchaseToUtilityName(
  purchase: string,
): UtilityName | null {
  switch (purchase) {
    case "flashbang":
    case "molotov":
    case "hegrenade":
    case "smokegrenade":
    case "incgrenade":
      return purchase;
    default:
      return null;
  }
}

export function normalizeThrownUtilityName(
  utility: string,
  side: Side | null,
): UtilityName | null {
  if (utility === "molotov" && side === "CT") {
    return "incgrenade";
  }

  return convertStringPurchaseToUtilityName(utility);
}
