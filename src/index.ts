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

app.post("/matches/import", async (c) => {
  const body = await c.req.json().catch(() => null);
  const sourceUrl = typeof body?.sourceUrl === "string" ? body.sourceUrl : null;

  const parsedUrl = validateSourceUrl(sourceUrl);
  if (!parsedUrl.success) {
    return c.json({ error: parsedUrl.error }, 400);
  }

  try {
    const stub = c.env.MATCH_ANALYZER.getByName(
      await getMatchObjectName(parsedUrl.url.toString()),
    );
    const report = await stub.importFromUrl(parsedUrl.url.toString());

    return c.json(report);
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to import match log.",
      },
      502,
    );
  }
});

app.get("/matches/report", async (c) => {
  const sourceUrl = c.req.query("sourceUrl");
  const parsedUrl = validateSourceUrl(sourceUrl);

  if (!parsedUrl.success) {
    return c.json({ error: parsedUrl.error }, 400);
  }

  const stub = c.env.MATCH_ANALYZER.getByName(
    await getMatchObjectName(parsedUrl.url.toString()),
  );
  const report = await stub.getReport();

  if (!report) {
    return c.json(
      { error: "No imported match log found for this sourceUrl." },
      404,
    );
  }

  return c.json(report);
});

app.delete("/matches/report", async (c) => {
  const sourceUrl = c.req.query("sourceUrl");
  const parsedUrl = validateSourceUrl(sourceUrl);

  if (!parsedUrl.success) {
    return c.json({ error: parsedUrl.error }, 400);
  }

  const stub = c.env.MATCH_ANALYZER.getByName(
    await getMatchObjectName(parsedUrl.url.toString()),
  );
  const deleted = await stub.clearReport();

  if (!deleted) {
    return c.json(
      { error: "No imported match log found for this sourceUrl." },
      404,
    );
  }

  return c.json({ ok: true, cleared: parsedUrl.url.toString() });
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

function validateSourceUrl(
  sourceUrl: string | null | undefined,
): { success: true; url: URL } | { success: false; error: string } {
  if (!sourceUrl) {
    return { success: false, error: "Expected a sourceUrl value." };
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    return { success: false, error: "sourceUrl must be a valid absolute URL." };
  }

  if (!parsedUrl.pathname.toLowerCase().endsWith(".txt")) {
    return {
      success: false,
      error: "sourceUrl must point to a .txt resource.",
    };
  }

  return { success: true, url: parsedUrl };
}

async function getMatchObjectName(sourceUrl: string): Promise<string> {
  const bytes = new TextEncoder().encode(sourceUrl);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export { MatchAnalyzerDurableObject, MatchReviewerDO };

export default app;
