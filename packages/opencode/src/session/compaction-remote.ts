import { Effect } from "effect"
import { Log } from "../util/log"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

/**
 * Remote compaction via Codex `/codex/responses/compact`.
 *
 * Returns the encrypted_content blob that the model can later decode
 * as latent state, plus the verbatim items the server retained
 * (so we can re-inject them as visible text to other providers).
 *
 * Reads OAuth credentials directly from the @guard22/opencode-multi-auth-codex
 * account store, which is the same mechanism the plugin uses for routing
 * to the ChatGPT backend.
 *
 * If credentials are unavailable or the call fails, returns undefined and
 * the caller MUST fall back to the regular text-summary compaction path.
 */
export namespace CompactionRemote {
  const log = Log.create({ service: "session.compaction.remote" })

  const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses/compact"

  export type RemoteInputItem =
    | {
        type: "message"
        role: "user" | "assistant" | "system"
        content: Array<{ type: "input_text" | "output_text"; text: string }>
      }
    | { type: string; [k: string]: unknown }

  export type RemoteOutputItem =
    | {
        id?: string
        type: "message"
        role: "user" | "assistant"
        content: Array<{ type: string; text?: string }>
      }
    | {
        id?: string
        type: "compaction_summary" | "compaction"
        encrypted_content: string
      }
    | { id?: string; type: string; [k: string]: unknown }

  export interface RemoteCompactResult {
    encryptedContent: string
    retained: RemoteOutputItem[]
    usage: { input_tokens: number; output_tokens: number; total_tokens: number }
  }

  function pickFreshestAccount():
    | { accessToken: string; accountId?: string; alias: string }
    | undefined {
    const storeDir = process.env.OPENCODE_MULTI_AUTH_STORE_DIR ??
      path.join(os.homedir(), ".config", "opencode-multi-auth")
    const storePath = path.join(storeDir, "accounts.json")
    let raw: string
    try {
      raw = fs.readFileSync(storePath, "utf8")
    } catch {
      return undefined
    }
    let data: any
    try {
      data = JSON.parse(raw)
    } catch {
      return undefined
    }
    const accounts: Record<string, any> = data?.accounts ?? {}
    const now = Date.now()
    type Cand = { alias: string; acc: any; remainingFiveHour: number; remainingWeekly: number; isPro: boolean }
    const eligible: Cand[] = []
    for (const [alias, acc] of Object.entries(accounts)) {
      if (acc.authInvalid || acc.enabled === false) continue
      if (acc.rateLimitedUntil && acc.rateLimitedUntil > now) continue
      if (acc.modelUnsupportedUntil && acc.modelUnsupportedUntil > now) continue
      if (acc.workspaceDeactivatedUntil && acc.workspaceDeactivatedUntil > now) continue
      if (typeof acc.accessToken !== "string" || !acc.accessToken) continue
      let plan: string | undefined
      try {
        const parts = (acc.idToken ?? acc.accessToken).split(".")
        if (parts.length === 3) {
          const padding = "=".repeat((-parts[1].length & 3) % 4)
          const payload = JSON.parse(Buffer.from(parts[1] + padding, "base64").toString("utf8"))
          plan = payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type
        }
      } catch {}
      eligible.push({
        alias,
        acc,
        remainingFiveHour: acc.rateLimits?.fiveHour?.remaining ?? 0,
        remainingWeekly: acc.rateLimits?.weekly?.remaining ?? 0,
        isPro: plan === "pro",
      })
    }
    if (eligible.length === 0) return undefined
    // Plus/Team first, Pro fallback (matches our rotation patch).
    const nonPro = eligible.filter((e) => !e.isPro)
    const pool = nonPro.length > 0 ? nonPro : eligible
    pool.sort((a, b) => b.remainingFiveHour - a.remainingFiveHour || b.remainingWeekly - a.remainingWeekly)
    const chosen = pool[0]
    return { accessToken: chosen.acc.accessToken, accountId: chosen.acc.accountId, alias: chosen.alias }
  }

  export const compact = Effect.fn("CompactionRemote.compact")(function* (input: {
    model: string
    instructions: string
    items: RemoteInputItem[]
  }) {
    const cred = pickFreshestAccount()
    if (!cred) {
      log.warn("no eligible account in multi-auth store — remote compaction unavailable")
      return undefined as RemoteCompactResult | undefined
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.accessToken}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      session_id: crypto.randomUUID(),
    }
    if (cred.accountId) headers["chatgpt-account-id"] = cred.accountId

    const body = {
      model: input.model,
      input: input.items,
      instructions: input.instructions,
      tools: [],
      parallel_tool_calls: false,
    }

    log.info("posting to /codex/responses/compact", {
      bytes: JSON.stringify(body).length,
      model: input.model,
      alias: cred.alias,
    })

    let res: Response
    try {
      res = yield* Effect.promise(() => fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body) }))
    } catch (err) {
      log.error("network failure", { err: String(err) })
      return undefined as RemoteCompactResult | undefined
    }

    if (!res.ok) {
      const text = (yield* Effect.promise(() => res.text())) as string
      log.warn("non-2xx from compact endpoint", { status: res.status, body: text.slice(0, 500) })
      return undefined as RemoteCompactResult | undefined
    }

    const json = (yield* Effect.promise(() => res.json())) as {
      output?: RemoteOutputItem[]
      usage?: { input_tokens: number; output_tokens: number; total_tokens: number }
    }
    const output = Array.isArray(json.output) ? json.output : []
    const summaryItem = output.find(
      (it: any) => it.type === "compaction_summary" || it.type === "compaction",
    ) as { encrypted_content?: string } | undefined
    const encrypted = summaryItem?.encrypted_content
    if (!encrypted) {
      log.warn("response had no compaction_summary item", {
        items: output.map((i: any) => i.type as string),
      })
      return undefined as RemoteCompactResult | undefined
    }

    return {
      encryptedContent: encrypted,
      retained: output,
      usage: json.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    } satisfies RemoteCompactResult
  })
}
