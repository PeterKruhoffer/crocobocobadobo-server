import type { PlayerRef } from "@/parser-core";
import { Side } from "@/parser-types";

type MutablePlayerRecord = {
  id: string;
  name: string;
  side: Side | null;
};

export function upsertPlayerRecord<T extends MutablePlayerRecord>(
  players: Map<string, T>,
  player: PlayerRef,
  create: (player: PlayerRef) => T,
): T {
  const existing = players.get(player.key);

  if (existing) {
    existing.name = player.name;

    if (player.side) {
      existing.side = player.side;
    }

    return existing;
  }

  const created = create(player);
  players.set(player.key, created);
  return created;
}
