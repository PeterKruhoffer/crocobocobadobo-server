import { DurableObject } from "cloudflare:workers";
import { ParsedLogResponse, parseMatchLog } from "@/parser";

export class MatchReviewerDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
    const report = parseMatchLog(log);
    if (report === null) {
      return null;
    }
    return report;
  }
}
