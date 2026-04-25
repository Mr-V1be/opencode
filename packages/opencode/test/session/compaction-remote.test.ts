import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { CompactionRemote } from "../../src/session/compaction-remote"

describe("CompactionRemote", () => {
  it("compacts a sample conversation and returns encrypted_content", async () => {
    const result = await Effect.runPromise(
      CompactionRemote.compact({
        model: "gpt-5.5",
        instructions: "Compact this coding-agent conversation. Preserve goals, files, and decisions.",
        items: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Hi, I am building a kanban CLI in Bun. Can you help?" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text:
                  "Sure. Let's start with package.json, src/cli.ts as entry, src/commands/{add,list,move,done,rm,show}.ts, src/storage.ts using ./.kanban.json, src/ui.ts for ANSI colors, src/types.ts for shared Task type. Tests in tests/*.test.ts using bun:test.",
              },
            ],
          },
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Great. Now add atomic write to storage and unit tests for add/move/rm.",
              },
            ],
          },
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text:
                  "Done: storage.ts now writes via fs.writeFile to a .tmp file then renames. Tests cover roundtrip + empty-file, add creates a task in todo, move changes column, rm removes by id. README has command reference.",
              },
            ],
          },
        ],
      }),
    )

    if (!result) {
      console.warn("CompactionRemote returned undefined — credentials/network unavailable, skipping assertions")
      return
    }

    console.log("compact usage:", result.usage)
    console.log("encrypted bytes:", result.encryptedContent.length)
    console.log("retained items:", result.retained.length)

    expect(typeof result.encryptedContent).toBe("string")
    expect(result.encryptedContent.length).toBeGreaterThan(100)
    expect(result.retained.length).toBeGreaterThan(0)
    expect(result.usage.total_tokens).toBeGreaterThan(0)
  }, 60_000)
})
