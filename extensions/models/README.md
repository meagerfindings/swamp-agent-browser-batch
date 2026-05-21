# @mgreten/agent-browser-batch

A [swamp](https://swamp.club) model that dispatches a list of
[agent-browser](https://github.com/vercel-labs/agent-browser) commands as a
single subprocess via `agent-browser batch --json`, with the command list
piped on stdin. Designed for multi-step browser flows (login + navigation +
screenshots + scraping) that need persistent cookie and Chromium state.

## Why this exists

`agent-browser` keeps its session state — cookies, localStorage, the attached
Chromium — in **daemon memory, not on disk**. When successive subprocess
invocations each call `agent-browser <cmd>` separately, the daemon can exit
between calls and a fresh daemon launches a fresh Chromium with no cookie
continuity. The typical symptom is a multi-step flow like
`login + nav + screenshot` reporting "post-login URL = /sign_in" with correct
credentials, because the form submitted in one Chromium and the URL check
happened in another.

`agent-browser batch` runs every step inside a single subprocess sharing a
single daemon and a single Chromium. This model wraps that with typed Zod
schemas, a `{{secret:NAME}}` substitution mechanism for credentials, and a
persisted artifact for every dispatch.

Tracked upstream as
[vercel-labs/agent-browser#1068](https://github.com/vercel-labs/agent-browser/issues/1068).

## Installation

```bash
swamp extension pull @mgreten/agent-browser-batch
```

You need `agent-browser` on your `PATH` (or point `binaryPath` at it). Install
instructions: <https://github.com/vercel-labs/agent-browser>.

## Setup

```bash
swamp model create @mgreten/agent-browser-batch browser \
  --global binaryPath=agent-browser \
  --global defaultTimeoutMs=120000
```

## Usage

### Simple — public page screenshot

```bash
swamp model method run browser runBatch --input 'commands:json=[
  ["open", "https://example.com"],
  ["wait", "1000"],
  ["get", "title"],
  ["screenshot", "/tmp/example.png"],
  ["close"]
]'
```

### Login flow with secrets

Read the password from a vault and pipe the full input via `--stdin` so the
plaintext never crosses the swamp CLI's argv boundary:

```bash
PASSWORD=$(swamp vault read-secret my-vault login-password --json | jq -r .value)

cat <<EOF | swamp model method run browser runBatch --stdin --json
{
  "commands": [
    ["open", "https://app.example.com/sign_in"],
    ["find", "label", "Email Address", "fill", "user@example.com"],
    ["find", "label", "Password", "fill", "{{secret:loginPassword}}"],
    ["press", "Enter"],
    ["wait", "2500"],
    ["open", "https://app.example.com/dashboard"],
    ["wait", "1500"],
    ["get", "url"],
    ["get", "title"],
    ["screenshot", "/tmp/dashboard.png"],
    ["close"]
  ],
  "secrets": { "loginPassword": "$PASSWORD" },
  "artifactName": "example-dashboard-smoke"
}
EOF
```

The persisted `batchRun` artifact records the `{{secret:loginPassword}}`
placeholder, not the value. The actual password reaches `agent-browser` only
through the subprocess's stdin and is never written to swamp's datastore,
audit log, or shell history.

## Global Arguments

| Name              | Type     | Default          | Description                                                                |
| ----------------- | -------- | ---------------- | -------------------------------------------------------------------------- |
| `binaryPath`      | `string` | `agent-browser`  | Path or name of the agent-browser executable (must be on `PATH` if unset). |
| `defaultTimeoutMs`| `number` | `120000`         | Default soft timeout for the whole batch in milliseconds.                  |

## Method: `runBatch`

Dispatch a list of agent-browser commands as one subprocess and return the
per-step result envelope.

### Arguments

| Name           | Type                        | Required | Description                                                                                                          |
| -------------- | --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `commands`     | `string[][]`                | yes      | Ordered list of agent-browser commands. Each inner array is one sub-command. Values can contain `{{secret:NAME}}`.   |
| `secrets`      | `Record<string, string>`    | no       | Map of secret name → value. Substituted into commands and stripped from the persisted artifact. Marked sensitive.    |
| `bail`         | `boolean`                   | no       | If `true`, `agent-browser` stops on the first failing step. Default `false`.                                         |
| `timeoutMs`    | `number`                    | no       | Soft timeout for the whole batch. Falls back to `globalArgs.defaultTimeoutMs`.                                       |
| `artifactName` | `string`                    | no       | Name for the recorded `batchRun` artifact. Defaults to `batch-{epoch}`.                                              |

### Output

Produces one `batchRun` artifact:

```json
{
  "startedAt": "2026-05-21T00:00:00.000Z",
  "finishedAt": "2026-05-21T00:00:17.000Z",
  "durationMs": 17000,
  "exitCode": 0,
  "stderr": "",
  "bail": false,
  "commands": [["open", "..."], ["...", "{{secret:loginPassword}}"]],
  "steps": [
    { "command": ["open", "..."], "success": true, "error": null, "result": { "url": "...", "title": "..." } }
  ],
  "okCount": 11,
  "failCount": 0,
  "status": "pass"
}
```

## How It Works

1. Caller passes a command list (and optional `secrets` map) via swamp's
   method invocation.
2. The model substitutes `{{secret:NAME}}` placeholders into a fresh copy of
   the command list.
3. A single `Deno.Command("agent-browser", ["batch", "--json", ...])`
   subprocess is spawned with `stdin: "piped"`.
4. The substituted command list is JSON-serialized and written to the
   subprocess's stdin.
5. The subprocess's stdout is decoded as a JSON array of
   `{command, success, error, result}` step envelopes and Zod-validated.
6. The persisted `batchRun` artifact records the **original** (non-substituted)
   commands so secrets never reach swamp's datastore.

### Prerequisites

- [agent-browser](https://github.com/vercel-labs/agent-browser) `0.26.0` or
  later on `PATH` (or point `binaryPath` at the binary). Earlier versions may
  lack the `batch` subcommand.
- A working browser install (`agent-browser install --with-deps` on Linux).

### What `agent-browser` commands are available

This model is a transport — it passes whatever you give it through to
`agent-browser batch`. For the full command surface (open, click, fill, find,
press, wait, get, screenshot, eval, snapshot, etc.) see
[`agent-browser --help`](https://github.com/vercel-labs/agent-browser) or run
`agent-browser skills get core --full`.

## License

MIT — see [LICENSE.txt](LICENSE.txt) for details.
