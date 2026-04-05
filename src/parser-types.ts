export type Side = "CT" | "T";

export type BombSite = "A" | "B";

export type RoundScore = {
  CT: number;
  T: number;
};

export type RoundWinReason =
  | "bomb_defused"
  | "bomb_exploded"
  | "cts_win"
  | "terrorists_win";

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

export type DerivedRoundWinReason =
  | "bomb_defused"
  | "bomb_exploded"
  | "team_wipe"
  | "time_ran_out"
  | "post_plant_elimination";

export type RoundPlayerIdentity = {
  id: string;
  name: string;
  side: Side | null;
};
