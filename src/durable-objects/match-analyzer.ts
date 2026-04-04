import { DurableObject } from 'cloudflare:workers'

import { parseMatchLog, type MatchReport } from '../match-log-parser'

type StoredReportRow = {
  report_json: string
}

const REPORT_ROW_ID = 'latest'

export class MatchAnalyzerDurableObject extends DurableObject {
  private readonly ready: Promise<void>

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)

    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS imported_reports (
          id TEXT PRIMARY KEY,
          source_url TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          raw_line_count INTEGER NOT NULL,
          report_json TEXT NOT NULL
        )
      `)
    })
  }

  async importFromUrl(sourceUrl: string): Promise<MatchReport> {
    await this.ready

    const response = await fetch(sourceUrl, {
      headers: {
        accept: 'text/plain, text/*;q=0.9, */*;q=0.1',
      },
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch match log: ${response.status} ${response.statusText}`)
    }

    const rawText = await response.text()
    const report = parseMatchLog(rawText, { sourceUrl })

    this.ctx.storage.sql.exec(
      `
        INSERT OR REPLACE INTO imported_reports (id, source_url, imported_at, raw_line_count, report_json)
        VALUES (?, ?, ?, ?, ?)
      `,
      REPORT_ROW_ID,
      sourceUrl,
      report.importedAt,
      report.summary.rawLineCount,
      JSON.stringify(report),
    )

    return report
  }

  async getReport(): Promise<MatchReport | null> {
    await this.ready

    const rows = this.ctx.storage.sql
      .exec<StoredReportRow>(
        `
          SELECT report_json
          FROM imported_reports
          WHERE id = ?
          LIMIT 1
        `,
        REPORT_ROW_ID,
      )
      .toArray()

    const row = rows[0]

    if (!row) {
      return null
    }

    return JSON.parse(row.report_json) as MatchReport
  }

  async clearReport(): Promise<boolean> {
    await this.ready

    const existingReport = await this.getReport()

    if (!existingReport) {
      return false
    }

    this.ctx.storage.sql.exec(
      `
        DELETE FROM imported_reports
        WHERE id = ?
      `,
      REPORT_ROW_ID,
    )

    return true
  }
}
