import { Hono } from "hono";

import { MatchAnalyzerDurableObject } from "./durable-objects/match-analyzer";
import { MatchReviewerDO } from "./durable-objects/matchReviewerDO";

type AppBindings = {
  MATCH_ANALYZER: DurableObjectNamespace<MatchAnalyzerDurableObject>;
  MATCH_REVIEWER: DurableObjectNamespace<MatchReviewerDO>;
};

const app = new Hono<{ Bindings: AppBindings }>();

app.get("/", (c) => {
  return c.json({
    name: "crocobocobadobo",
    endpoints: {
      importMatchLog: "POST /matches/import",
      getMatchReport: "GET /matches/report?sourceUrl=...",
      clearMatchReport: "DELETE /matches/report?sourceUrl=...",
    },
  });
});

app.get("/matches", async (c) => {
  const url = c.req.query("url");
  if (!url) {
    console.log("[MATCHES Endpoint]: Url is undefined");
    return c.json({ error: "No match log found for this url." }, 400);
  }
  const id = c.env.MATCH_REVIEWER.idFromName("matchreviewer");
  const stub = c.env.MATCH_REVIEWER.get(id);
  const matchLog = await stub.getMatchLog(url);

  if (!matchLog) {
    return c.json({ error: "No imported match log found for this url." }, 404);
  }

  return c.json(matchLog);
});

export { MatchAnalyzerDurableObject, MatchReviewerDO };

export default app;
