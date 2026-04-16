import { DurableObject } from "cloudflare:workers";
import { parseMatchLog } from "@/parser/parser";
import { ParsedLogResponse } from "@/parser/parser-types";

export class MatchReviewerDO extends DurableObject<CloudflareBindings> {
  sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);

    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS review(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          imported_at TEXT NOT NULL,
          review_json TEXT NOT NULL
    );
`);
  }

  async getMatchLog(url: string): Promise<ParsedLogResponse | null> {
    const response = await fetch(url, {
      headers: {
        accept: "text/plain",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch match log: ${response.status} ${response.statusText}`,
      );
    }

    const log = await response.text();
    const importedAt = new Date().toISOString();
    const report = parseMatchLog(log);
    if (report === null) {
      return null;
    }

    this.ctx.storage.sql.exec(
      `
        INSERT OR REPLACE INTO review (imported_at, review_json)
        VALUES (?, ?)
      `,
      importedAt,
      JSON.stringify(report),
    );

    return report;
  }

  async clearDo(): Promise<void> {
    // This will delete all the storage associated with this Durable Object instance
    // This will also delete the Durable Object instance itself
    await this.ctx.storage.deleteAll();
  }
}
