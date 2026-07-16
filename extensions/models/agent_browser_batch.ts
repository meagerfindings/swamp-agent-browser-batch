/**
 * Dispatch a list of [agent-browser](https://github.com/vercel-labs/agent-browser)
 * commands as ONE subprocess via `agent-browser batch --json`, with the
 * command list piped on stdin. Returns the typed per-step result envelope.
 *
 * Why a single subprocess (the load-bearing reason this model exists):
 * `agent-browser` keeps its session state — cookies, localStorage, the
 * attached Chromium — in daemon memory, NOT on disk. When successive
 * Deno.Command sub-shells invoke `agent-browser <cmd>` separately, the
 * daemon may exit between calls (idle timeout) and a fresh daemon launches
 * a fresh Chromium with no cookie continuity. The symptom is a multi-step
 * flow like `login + nav + screenshot` reporting "post-login URL =
 * /sign_in" with correct credentials, because the form submitted in
 * browser A and the URL check happened in browser B. One `batch`
 * invocation = one daemon = one Chromium = persistent state across every
 * step. See [vercel-labs/agent-browser#1068].
 *
 * Secrets handling: any value in `commands` of the form `{{secret:NAME}}`
 * is substituted from the sensitive `secrets` argument map at dispatch
 * time and never persisted in the resulting `batchRun` artifact. This
 * keeps credentials out of swamp's datastore + audit log + process argv.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Schema for shared globalArgs. */
const GlobalArgsSchema: z.ZodObject<{
  binaryPath: z.ZodString;
  defaultTimeoutMs: z.ZodNumber;
}> = z.object({
  binaryPath: z
    .string()
    .default("agent-browser")
    .describe(
      "Path or name of the agent-browser executable. Defaults to `agent-browser` (found on PATH).",
    ),
  defaultTimeoutMs: z
    .number()
    .default(120_000)
    .describe(
      "Default soft timeout for the whole batch in milliseconds. Surfaces as a non-zero exit code and stderr if exceeded.",
    ),
});

/** Outcome of one logical agent-browser sub-command inside the batch. */
const BatchStepSchema: z.ZodObject<{
  command: z.ZodArray<z.ZodString>;
  success: z.ZodBoolean;
  error: z.ZodNullable<z.ZodString>;
  result: z.ZodNullable<z.ZodUnknown>;
}> = z.object({
  command: z.array(z.string()),
  success: z.boolean(),
  error: z.string().nullable(),
  result: z.unknown().nullable(),
});

/** Resource artifact recording a full batch invocation. */
const BatchRunSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  exitCode: z.number(),
  stderr: z.string(),
  bail: z.boolean(),
  commands: z.array(z.array(z.string())),
  steps: z.array(BatchStepSchema),
  okCount: z.number(),
  failCount: z.number(),
  status: z.enum(["pass", "fail"]),
});

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

/** Regex for `{{secret:NAME}}` placeholders. NAME is a Zod-friendly key. */
const SECRET_PLACEHOLDER: RegExp = /\{\{secret:([A-Za-z0-9_-]+)\}\}/g;

/**
 * Replace `{{secret:NAME}}` placeholders inside a single command argument
 * with the corresponding value from the secrets map. Unknown placeholders
 * are left untouched (they become a literal arg passed to agent-browser).
 *
 * @param arg - One argv string from a command.
 * @param secrets - Map of secret name → value (sensitive).
 * @returns The arg with placeholders substituted.
 */
function substituteSecrets(
  arg: string,
  secrets: Record<string, string>,
): string {
  return arg.replace(SECRET_PLACEHOLDER, (match, name: string) => {
    const value = secrets[name];
    return value !== undefined ? value : match;
  });
}

/**
 * Apply secret substitution to every argument of every command in a list.
 *
 * @param commands - Original command list (may contain placeholders).
 * @param secrets - Map of secret name → value.
 * @returns A fresh list with substitutions applied.
 */
function substituteCommands(
  commands: string[][],
  secrets: Record<string, string>,
): string[][] {
  return commands.map((cmd) =>
    cmd.map((arg) => substituteSecrets(arg, secrets))
  );
}

/**
 * Reverse of substituteSecrets: replace any literal secret value found in
 * `arg` with its `{{secret:NAME}}` placeholder. Used to scrub credentials
 * out of agent-browser's echoed-back command arrays before persisting the
 * batchRun artifact.
 *
 * @param arg - String potentially containing a secret value.
 * @param secrets - Map of secret name → value.
 * @returns The arg with literal secret values rewritten back to placeholders.
 */
function redactSecrets(
  arg: string,
  secrets: Record<string, string>,
): string {
  let result = arg;
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length === 0) continue;
    while (result.includes(value)) {
      result = result.replace(value, `{{secret:${name}}}`);
    }
  }
  return result;
}

/**
 * Walk a parsed batch step and scrub any secret values out of the echoed
 * `command` array (and any string fields nested inside `result`) by
 * replacing them with the original `{{secret:NAME}}` placeholder.
 *
 * @param step - One step result from agent-browser.
 * @param secrets - Map of secret name → value.
 * @returns A fresh step with secrets redacted from `command` and `result`.
 */
function redactStep(
  step: z.infer<typeof BatchStepSchema>,
  secrets: Record<string, string>,
): z.infer<typeof BatchStepSchema> {
  const redactValue = (v: unknown): unknown => {
    if (typeof v === "string") return redactSecrets(v, secrets);
    if (Array.isArray(v)) return v.map(redactValue);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        out[k] = redactValue(vv);
      }
      return out;
    }
    return v;
  };

  return {
    ...step,
    command: step.command.map((a) => redactSecrets(a, secrets)),
    result: redactValue(step.result) as typeof step.result,
    error: step.error === null ? null : redactSecrets(step.error, secrets),
  };
}

/**
 * Outcome of one `runBatch` dispatch — the typed per-step results plus the
 * subprocess exit envelope.
 */
type BatchOutcome = {
  steps: z.infer<typeof BatchStepSchema>[];
  exitCode: number;
  stderr: string;
  parseError: string | null;
};

/**
 * Spawn `agent-browser batch --json` (optionally `--bail`) in a single
 * subprocess and pipe the JSON command list to its stdin. Decode stdout
 * as a JSON array of step results.
 *
 * @param binaryPath - Path/name of the agent-browser executable.
 * @param commands - Command list with secrets already substituted in.
 * @param bail - If true, agent-browser stops on the first failing step.
 * @param timeoutMs - Soft timeout for the whole batch.
 * @returns Per-step results + the exit envelope.
 */
async function dispatchBatch(
  binaryPath: string,
  commands: string[][],
  bail: boolean,
  timeoutMs: number,
): Promise<BatchOutcome> {
  const args = ["batch", "--json"];
  if (bail) args.push("--bail");

  const proc = new Deno.Command(binaryPath, {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const writer = proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(commands)));
  await writer.close();

  const timeout = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch (_e) {
      // Already exited.
    }
  }, timeoutMs);

  const output = await proc.output();
  clearTimeout(timeout);

  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);

  let steps: z.infer<typeof BatchStepSchema>[] = [];
  let parseError: string | null = null;
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      steps = parsed.map((s) => BatchStepSchema.parse(s));
    } else {
      parseError = "agent-browser batch returned non-array JSON";
    }
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e);
  }

  return { steps, exitCode: output.code, stderr, parseError };
}

/** Swamp model for invoking agent-browser as a single-subprocess batch. */
export const model = {
  type: "@mgreten/agent-browser-batch",
  version: "2026.07.16.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    batchRun: {
      description:
        "One agent-browser batch invocation: the command list, every per-step result, exit envelope, and pass/fail summary.",
      schema: BatchRunSchema,
      lifetime: "7d" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    runBatch: {
      description:
        "Dispatch a list of agent-browser commands as a single subprocess via `agent-browser batch --json` (stdin-piped JSON). Returns the typed per-step result envelope. The whole flow shares one daemon and one Chromium, so cookies + localStorage persist across every step — required for multi-step flows like login + nav + screenshot. Use `{{secret:NAME}}` placeholders for credentials and pass values via the sensitive `secrets` arg to keep them out of the persisted artifact.",
      arguments: z.object({
        commands: z
          .array(z.array(z.string()))
          .describe(
            'Ordered list of agent-browser commands. Each inner array is one sub-command: e.g. `["open", "https://x"]`, `["find", "label", "Email", "fill", "a@b.c"]`, `["press", "Enter"]`, `["wait", "1500"]`, `["get", "url"]`, `["screenshot", "/path/out.png"]`, `["close"]`. Values can contain `{{secret:NAME}}` placeholders.',
          ),
        secrets: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Map of secret name → value. Substituted into `commands` at dispatch time and stripped from the persisted artifact (placeholders are recorded instead of values).",
          )
          .meta({ sensitive: true }),
        bail: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "If true, agent-browser stops on the first failing step. Default false: every step runs and the caller inspects per-step `success`.",
          ),
        timeoutMs: z
          .number()
          .optional()
          .describe(
            "Soft timeout for the whole batch. Falls back to globalArgs.defaultTimeoutMs when omitted.",
          ),
        artifactName: z
          .string()
          .optional()
          .describe(
            "Name for the recorded batchRun artifact. Defaults to `batch-{epoch}`.",
          ),
      }),
      execute: async (
        args: {
          commands: string[][];
          secrets?: Record<string, string>;
          bail?: boolean;
          timeoutMs?: number;
          artifactName?: string;
        },
        context: MethodContext,
      ) => {
        const ga = context.globalArgs;
        const bail = args.bail ?? false;
        const timeoutMs = args.timeoutMs ?? ga.defaultTimeoutMs;
        const secrets = args.secrets ?? {};

        const startedAtIso = new Date().toISOString();
        const startedMs = Date.now();

        context.logger.info(
          "agent-browser batch: dispatching {n} commands (bail={bail}, timeout={timeout}ms)",
          { n: args.commands.length, bail, timeout: timeoutMs },
        );

        const substituted = substituteCommands(args.commands, secrets);
        const outcome = await dispatchBatch(
          ga.binaryPath,
          substituted,
          bail,
          timeoutMs,
        );

        // agent-browser echoes the substituted commands back in each step's
        // `command` field, and may also embed credential strings in `result`
        // or `error` (e.g. echoed form values). Scrub them back to
        // `{{secret:NAME}}` placeholders before the artifact is persisted.
        const redactedSteps = outcome.steps.map((s) => redactStep(s, secrets));
        const redactedStderr = redactSecrets(outcome.stderr, secrets);

        const finishedMs = Date.now();
        const okCount = redactedSteps.filter((s) => s.success).length;
        const failCount = redactedSteps.length - okCount;
        const allSucceeded = outcome.exitCode === 0 &&
          outcome.parseError === null && failCount === 0;

        if (outcome.parseError) {
          context.logger.warning(
            "agent-browser batch JSON parse failed: {err}",
            { err: outcome.parseError },
          );
        }
        if (outcome.exitCode !== 0) {
          context.logger.warning(
            "agent-browser batch exit code {code}: {stderr}",
            { code: outcome.exitCode, stderr: outcome.stderr.slice(0, 400) },
          );
        }

        const record: z.infer<typeof BatchRunSchema> = {
          startedAt: startedAtIso,
          finishedAt: new Date().toISOString(),
          durationMs: finishedMs - startedMs,
          exitCode: outcome.exitCode,
          stderr: redactedStderr.slice(0, 4000),
          bail,
          commands: args.commands,
          steps: redactedSteps,
          okCount,
          failCount,
          status: allSucceeded ? "pass" : "fail",
        };

        const instanceName = args.artifactName ?? `batch-${Date.now()}`;
        const handle = await context.writeResource(
          "batchRun",
          instanceName,
          record as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
