import { Hono } from "hono";

import { MatchReviewerDO } from "./durable-objects/matchReviewerDO";

type AppBindings = {
  MATCH_REVIEWER: DurableObjectNamespace<MatchReviewerDO>;
};

const app = new Hono<{ Bindings: AppBindings }>();

app.get("/", (c) => {
  return c.json({
    name: "crocobocobadobo",
    endpoints: {
      getMatchReport: "GET /matches?url=...",
    },
  });
});

const NAME_OF_DO = "matchreviewer";

app.get("/matches", async (c) => {
  const url = c.req.query("url");
  if (!url) {
    console.log("[MATCHES Endpoint]: Url is undefined");
    return c.json({ error: "No match log found for this url." }, 400);
  }
  // Will always hit the same instance of Durable Object
  // Can be made to be diffrent per match if needed/wanted by making the name diffrent every request
  // Current usecase is 1 match
  const id = c.env.MATCH_REVIEWER.idFromName(NAME_OF_DO);
  const stub = c.env.MATCH_REVIEWER.get(id);
  const matchLog = await stub.getMatchLog(url);

  if (!matchLog) {
    return c.json({ error: "No imported match log found for this url." }, 404);
  }

  return c.json(matchLog);
});

app.delete("/admin/clear", async (c) => {
  const id = c.env.MATCH_REVIEWER.idFromName(NAME_OF_DO);
  const stub = c.env.MATCH_REVIEWER.get(id);
  await stub.clearDo();

  return c.json({ message: "Data has been cleared" });
});

export { MatchReviewerDO };

export default app;
