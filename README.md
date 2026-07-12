# Merlin Worker

Small Windows HTTP worker used by `merlin-api` to run local activation helper tools on a machine that has the required desktop sessions already configured.

The worker is intentionally simple:

- reads configuration from `.env`
- requires a bearer token when `WORKER_TOKEN` is set
- runs each job in an isolated temporary working directory
- allows concurrent requests; tune API-side limits according to VPS capacity
- exposes health/status information for operational checks

Do not commit `.env`, generated logs, generated tokens, or helper executables.

## Requirements

- Windows VPS or Windows desktop
- Node.js available in `PATH`
- Required helper executables installed on the same machine
- Any desktop account/session required by those helper tools already logged in

Install dependencies:

```powershell
npm install
```

## Configuration

Copy the example file:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` with the paths for your machine.

Important variables:

- `PORT`: HTTP port to listen on. Default recommendation: `8080`.
- `HOST`: bind address. Use `0.0.0.0` only when firewall access is configured intentionally.
- `WORKER_TOKEN`: long random bearer token expected in `Authorization: Bearer ...`.
- `STEAM_TICKET_GENERATOR_EXE_PATH`: absolute path to the Steam ticket helper executable.
- `STEAM_TICKET_GENERATOR_WORKDIR`: folder containing the Steam helper and its required DLLs.
- `STEAM_TICKET_GENERATOR_JOBS_DIR`: temporary folder for isolated Steam jobs.
- `THIRD_PARTY_TOKEN_GENERATOR_EXE_PATH`: absolute path to the third-party token helper executable.
- `THIRD_PARTY_TOKEN_GENERATOR_WORKDIR`: folder containing that helper and its required local data.
- `THIRD_PARTY_TOKEN_OUTPUT_PATH`: path where the helper writes its token output.
- `THIRD_PARTY_TOKEN_JOBS_DIR`: temporary folder for isolated third-party jobs.

`WORKER_TOKEN` must be treated as a secret. Store the matching value in `merlin-api` as an environment variable/secret, not in source control.

## Run Locally

```powershell
npm start
```

Health check:

```powershell
Invoke-RestMethod -Method GET -Uri "http://127.0.0.1:8080/health"
```

Useful health fields:

- `requiresAuth`
- `generatorConfigured`
- `generatorError`
- `thirdPartyTokenGeneratorConfigured`
- `thirdPartyTokenGeneratorError`

## Endpoints

### `GET /health`

Returns worker status and helper configuration status.

This endpoint does not run activation helpers.

### `POST /ticket-jobs`

Runs the Steam ticket helper.

Headers:

```http
Authorization: Bearer <WORKER_TOKEN>
Content-Type: application/json
```

Body:

```json
{
  "appId": 123456,
  "steamAccountId": "00000000000000000"
}
```

### `POST /token-jobs-third-party`

Runs the third-party token helper.

Headers:

```http
Authorization: Bearer <WORKER_TOKEN>
Content-Type: application/json
```

Body:

```json
{
  "tokenReq": "paste-request-value-here"
}
```

## Test Requests

Steam ticket job:

```powershell
$headers = @{ Authorization = "Bearer <WORKER_TOKEN>" }
$body = @{
  appId = 123456
  steamAccountId = "00000000000000000"
} | ConvertTo-Json -Compress

Invoke-RestMethod `
  -Method POST `
  -Uri "http://127.0.0.1:8080/ticket-jobs" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body
```

Third-party token job:

```powershell
$headers = @{ Authorization = "Bearer <WORKER_TOKEN>" }
$body = @{
  tokenReq = "paste-request-value-here"
} | ConvertTo-Json -Compress

Invoke-RestMethod `
  -Method POST `
  -Uri "http://127.0.0.1:8080/token-jobs-third-party" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body
```

## Windows Autostart

This worker is designed to run under the logged-in Windows user session, not as `SYSTEM`, because the helper tools may depend on desktop/user sessions.

Included scripts:

- `start-merlin-worker.cmd`
- `install-autostart.ps1`
- `uninstall-autostart.ps1`

Install scheduled task:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\install-autostart.ps1
```

Remove scheduled task:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1
```

The scheduled task:

- starts on user logon
- avoids starting a duplicate `node server.js`
- writes logs to `.\logs\`
- launches Node in a hidden window

If the VPS must recover after reboot without manual login, configure Windows auto-logon for the same user account.

## Security Notes

- Keep the worker behind a firewall whenever possible.
- Allow inbound traffic only from trusted sources.
- Always set `WORKER_TOKEN` outside local development.
- Never commit `.env`.
- Never commit generated `token.txt`, `token.ini`, `token_req.txt`, `configs.user.ini`, or logs.
- Rotate `WORKER_TOKEN` if it is ever exposed.

## GitHub Checklist

Before the initial commit:

```powershell
git status --short
```

Make sure these are not staged:

- `.env`
- `logs/`
- helper executables
- generated token/config files
