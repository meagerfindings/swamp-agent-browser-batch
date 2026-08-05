import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  BatchRunSchema,
  BatchStepSchema,
  closeOrphanedSession,
  dispatchBatch,
  GlobalArgsSchema,
  redactSecrets,
  redactStep,
  substituteCommands,
  substituteSecrets,
} from "./agent_browser_batch.ts";

Deno.test("GlobalArgsSchema: applies stable defaults", () => {
  assertEquals(GlobalArgsSchema.parse({}), {
    binaryPath: "agent-browser",
    defaultTimeoutMs: 120_000,
  });
});

Deno.test("GlobalArgsSchema: preserves explicit configuration and rejects invalid timeout", () => {
  assertEquals(GlobalArgsSchema.parse({ binaryPath: "/bin/browser", defaultTimeoutMs: 25 }), {
    binaryPath: "/bin/browser",
    defaultTimeoutMs: 25,
  });
  assertThrows(() => GlobalArgsSchema.parse({ defaultTimeoutMs: "25" }));
});

Deno.test("BatchStepSchema: accepts structured results and nullable fields", () => {
  const step = { command: ["get", "url"], success: true, error: null, result: { url: "https://example.com" } };
  assertEquals(BatchStepSchema.parse(step), step);
});

Deno.test("BatchStepSchema: rejects malformed command and success fields", () => {
  assertThrows(() => BatchStepSchema.parse({ command: "open", success: true, error: null, result: null }));
  assertThrows(() => BatchStepSchema.parse({ command: ["open"], success: "yes", error: null, result: null }));
});

Deno.test("BatchRunSchema: enforces status and complete result envelope", () => {
  const run = {
    startedAt: "start", finishedAt: "finish", durationMs: 4, exitCode: 0,
    stderr: "", bail: false, commands: [["open", "https://example.com"]],
    steps: [{ command: ["open", "https://example.com"], success: true, error: null, result: null }],
    okCount: 1, failCount: 0, status: "pass" as const,
  };
  assertEquals(BatchRunSchema.parse(run), run);
  assertThrows(() => BatchRunSchema.parse({ ...run, status: "unknown" }));
});

Deno.test("substituteSecrets: replaces repeated and adjacent known placeholders", () => {
  assertEquals(
    substituteSecrets("{{secret:user}}:{{secret:pass}}/{{secret:user}}", { user: "mat", pass: "s3cret" }),
    "mat:s3cret/mat",
  );
});

Deno.test("substituteSecrets: leaves unknown and malformed placeholders literal", () => {
  assertEquals(substituteSecrets("{{secret:missing}} {{secret:bad.name}}", {}), "{{secret:missing}} {{secret:bad.name}}");
});

Deno.test("substituteCommands: returns a substituted copy without mutating input", () => {
  const commands = [["fill", "{{secret:credential}}"], ["press", "Enter"]];
  const result = substituteCommands(commands, { credential: "replacement-value" });
  assertEquals(result, [["fill", "replacement-value"], ["press", "Enter"]]);
  assertEquals(commands, [["fill", "{{secret:credential}}"], ["press", "Enter"]]);
});

Deno.test("redactSecrets: redacts every occurrence and ignores empty values", () => {
  assertEquals(redactSecrets("token-token", { api: "token", empty: "" }), "{{secret:api}}-{{secret:api}}");
});

Deno.test("redactSecrets: is idempotent after secrets are replaced", () => {
  const once = redactSecrets("prefix private suffix", { key: "private" });
  assertEquals(redactSecrets(once, { key: "private" }), once);
});

Deno.test("redactStep: deeply redacts command, error, arrays, and object values", () => {
  const step = {
    command: ["fill", "private"], success: false, error: "rejected private",
    result: { nested: ["private", { message: "private" }], untouched: 42 },
  };
  assertEquals(redactStep(step, { credential: "private" }), {
    command: ["fill", "{{secret:credential}}"], success: false,
    error: "rejected {{secret:credential}}",
    result: { nested: ["{{secret:credential}}", { message: "{{secret:credential}}" }], untouched: 42 },
  });
});

Deno.test("redactStep: preserves nulls and does not mutate the source step", () => {
  const step = { command: ["get", "url"], success: true, error: null, result: null };
  assertEquals(redactStep(step, { key: "secret" }), step);
  assertEquals(step, { command: ["get", "url"], success: true, error: null, result: null });
});

Deno.test("closeOrphanedSession: resolves without throwing when the binary does not exist", async () => {
  await closeOrphanedSession("/nonexistent/agent-browser-binary");
});

/**
 * Writes a fake `agent-browser` executable: `batch` hangs forever (simulating
 * a wedged daemon), `close` writes a sentinel file and exits immediately. Lets
 * dispatchBatch's timeout->closeOrphanedSession path be exercised without a
 * real agent-browser install or a genuinely hung process.
 */
async function writeFakeBinary(sentinelPath: string): Promise<string> {
  const scriptPath = await Deno.makeTempFile({ suffix: ".sh" });
  await Deno.writeTextFile(
    scriptPath,
    `#!/bin/sh
if [ "$1" = "close" ]; then
  touch "${sentinelPath}"
  exit 0
fi
# "batch" (or anything else): hang until killed.
cat >/dev/null
sleep 60
`,
  );
  await Deno.chmod(scriptPath, 0o755);
  return scriptPath;
}

Deno.test("dispatchBatch: on timeout, kills the process and closes the orphaned session", async () => {
  const sentinelPath = await Deno.makeTempFile();
  await Deno.remove(sentinelPath);
  const binaryPath = await writeFakeBinary(sentinelPath);

  try {
    const outcome = await dispatchBatch(binaryPath, [["open", "https://example.com"]], false, 200);

    assertEquals(outcome.exitCode !== 0, true);

    let sentinelWritten = false;
    for (let i = 0; i < 20; i++) {
      if (await Deno.stat(sentinelPath).then(() => true, () => false)) {
        sentinelWritten = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assertEquals(sentinelWritten, true);
  } finally {
    await Deno.remove(binaryPath).catch(() => {});
    await Deno.remove(sentinelPath).catch(() => {});
  }
});
