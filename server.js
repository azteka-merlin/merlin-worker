require("dotenv").config();
const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
const GENERATOR_EXE_PATH = process.env.STEAM_TICKET_GENERATOR_EXE_PATH || "";
const GENERATOR_WORKDIR = process.env.STEAM_TICKET_GENERATOR_WORKDIR || "";
const GENERATOR_CONFIG_PATH = process.env.STEAM_TICKET_GENERATOR_CONFIG_PATH || "";
const GENERATOR_LOG_PATH = process.env.STEAM_TICKET_GENERATOR_LOG_PATH || "";
const STEAM_TICKET_GENERATOR_JOBS_DIR = process.env.STEAM_TICKET_GENERATOR_JOBS_DIR || "";
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 60000);
const THIRD_PARTY_TOKEN_GENERATOR_EXE_PATH = process.env.THIRD_PARTY_TOKEN_GENERATOR_EXE_PATH || "";
const THIRD_PARTY_TOKEN_GENERATOR_WORKDIR = process.env.THIRD_PARTY_TOKEN_GENERATOR_WORKDIR || "";
const THIRD_PARTY_TOKEN_OUTPUT_PATH = process.env.THIRD_PARTY_TOKEN_OUTPUT_PATH || "";
const THIRD_PARTY_TOKEN_JOBS_DIR = process.env.THIRD_PARTY_TOKEN_JOBS_DIR || "";
const THIRD_PARTY_TOKEN_TIMEOUT_MS = Number(process.env.THIRD_PARTY_TOKEN_TIMEOUT_MS || JOB_TIMEOUT_MS);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function isAuthorized(req) {
  if (!WORKER_TOKEN) {
    return true;
  }

  const authHeader = req.headers.authorization || "";
  return authHeader === `Bearer ${WORKER_TOKEN}`;
}

function validateTicketJobPayload(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "Body must be a JSON object";
  }

  if (typeof payload.appId !== "number" && typeof payload.appId !== "string") {
    return "appId must be a positive integer";
  }

  if (typeof payload.steamAccountId !== "string" || payload.steamAccountId.trim() === "") {
    return "steamAccountId must be a numeric string";
  }

  if (!/^\d+$/.test(String(payload.appId).trim())) {
    return "appId must be a positive integer";
  }

  if (!/^\d+$/.test(payload.steamAccountId.trim())) {
    return "steamAccountId must be a numeric string";
  }

  return null;
}

function validateThirdPartyTokenJobPayload(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return "Body must be a JSON object";
  }

  if (typeof payload.tokenReq !== "string" || payload.tokenReq.trim() === "") {
    return "tokenReq must be a non-empty string";
  }

  return null;
}

function getGeneratorPaths() {
  const exePath = GENERATOR_EXE_PATH.trim();

  if (!exePath) {
    throw new Error("STEAM_TICKET_GENERATOR_EXE_PATH is not configured");
  }

  const workdir = (GENERATOR_WORKDIR || path.dirname(exePath)).trim();
  const configPath = (GENERATOR_CONFIG_PATH || path.join(workdir, "configs.user.ini")).trim();
  const logPath = (GENERATOR_LOG_PATH || path.join(workdir, "steam-ticket-generator.log")).trim();
  const jobsDir = (STEAM_TICKET_GENERATOR_JOBS_DIR || path.join(os.tmpdir(), "merlin-worker-ticket-jobs")).trim();

  return { exePath, workdir, configPath, logPath, jobsDir };
}

function getThirdPartyTokenGeneratorPaths() {
  const exePath = THIRD_PARTY_TOKEN_GENERATOR_EXE_PATH.trim();

  if (!exePath) {
    throw new Error("THIRD_PARTY_TOKEN_GENERATOR_EXE_PATH is not configured");
  }

  const workdir = (THIRD_PARTY_TOKEN_GENERATOR_WORKDIR || path.dirname(exePath)).trim();
  const outputPath = (THIRD_PARTY_TOKEN_OUTPUT_PATH || path.join(workdir, "token", "token.txt")).trim();
  const jobsDir = (THIRD_PARTY_TOKEN_JOBS_DIR || path.join(os.tmpdir(), "merlin-worker-token-jobs")).trim();

  return { exePath, workdir, outputPath, jobsDir };
}

function resolveInside(basePath, targetPath, label, baseLabel) {
  const relativePath = path.relative(basePath, targetPath);

  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be inside ${baseLabel}`);
  }

  return relativePath;
}

function parseConfigIni(content) {
  const result = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("[") || !line.includes("=")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    result[key] = value;
  }

  return result;
}

function parseGeneratorOutput(stdout, stderr) {
  const merged = [stdout, stderr].filter(Boolean).join("\n");
  const steamIdMatch = merged.match(/Steam ID:\s*(\d+)/);
  const configSteamIdMatch = merged.match(/Config Steam User ID:\s*(\d+)/);
  const ticketMatch = merged.match(/Encrypted App Ticket:\s*(.+)/);

  return {
    steamId: steamIdMatch ? steamIdMatch[1] : null,
    configSteamUserId: configSteamIdMatch ? configSteamIdMatch[1] : null,
    ticket: ticketMatch ? ticketMatch[1].trim() : null,
  };
}

function runGenerator({ exePath, workdir, appId, steamAccountId }) {
  return new Promise((resolve, reject) => {
    execFile(
      exePath,
      [String(appId), String(steamAccountId)],
      {
        cwd: workdir,
        timeout: JOB_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject({
            message: error.message,
            code: typeof error.code === "number" ? error.code : null,
            killed: Boolean(error.killed),
            signal: error.signal || null,
            stdout: stdout || "",
            stderr: stderr || "",
          });
          return;
        }

        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );
  });
}

function runThirdPartyTokenGenerator({ exePath, workdir, tokenReq }) {
  return new Promise((resolve, reject) => {
    execFile(
      exePath,
      ["-token", tokenReq],
      {
        cwd: workdir,
        timeout: THIRD_PARTY_TOKEN_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject({
            message: error.message,
            code: typeof error.code === "number" ? error.code : null,
            killed: Boolean(error.killed),
            signal: error.signal || null,
            stdout: stdout || "",
            stderr: stderr || "",
          });
          return;
        }

        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );
  });
}

async function readOptionalUtf8File(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function removeDirectoryIfExists(directoryPath) {
  await fs.rm(directoryPath, { recursive: true, force: true });
}

async function createIsolatedJobWorkspace({
  exePath,
  workdir,
  outputPaths,
  jobsDir,
  exeLabel,
  workdirLabel,
}) {
  const jobId = randomUUID();
  const exeRelativePath = resolveInside(workdir, exePath, exeLabel, workdirLabel);
  const outputRelativePaths = Object.fromEntries(
    Object.entries(outputPaths).map(([key, value]) => [
      key,
      resolveInside(workdir, value, key, workdirLabel),
    ])
  );
  const jobWorkdir = path.join(jobsDir, jobId);
  const resolvedJobsDir = path.resolve(jobsDir).toLowerCase();

  await fs.mkdir(jobsDir, { recursive: true });
  await fs.cp(workdir, jobWorkdir, {
    recursive: true,
    force: true,
    filter: (sourcePath) => {
      const resolvedSourcePath = path.resolve(sourcePath).toLowerCase();
      return resolvedSourcePath !== resolvedJobsDir
        && !resolvedSourcePath.startsWith(`${resolvedJobsDir}${path.sep}`);
    },
  });

  const jobExePath = path.join(jobWorkdir, exeRelativePath);
  const jobOutputPaths = Object.fromEntries(
    Object.entries(outputRelativePaths).map(([key, value]) => [key, path.join(jobWorkdir, value)])
  );

  for (const jobOutputPath of Object.values(jobOutputPaths)) {
    await fs.mkdir(path.dirname(jobOutputPath), { recursive: true });
    await removeIfExists(jobOutputPath);
  }

  return {
    jobId,
    jobWorkdir,
    jobExePath,
    jobOutputPaths,
  };
}

async function executeTicketJob({ appId, steamAccountId }) {
  const { exePath, workdir, configPath, logPath, jobsDir } = getGeneratorPaths();
  await fs.access(exePath);
  await fs.access(workdir);

  let workspace = null;

  try {
    workspace = await createIsolatedJobWorkspace({
      exePath,
      workdir,
      outputPaths: {
        configPath,
        logPath,
      },
      jobsDir,
      exeLabel: "STEAM_TICKET_GENERATOR_EXE_PATH",
      workdirLabel: "STEAM_TICKET_GENERATOR_WORKDIR",
    });
  } catch (error) {
    return {
      ok: false,
      message: "ticket_workspace_failed",
      appId,
      steamAccountId,
      error: error.message,
    };
  }

  let execution;

  try {
    execution = await runGenerator({
      exePath: workspace.jobExePath,
      workdir: workspace.jobWorkdir,
      appId,
      steamAccountId,
    });
  } catch (error) {
    const configIni = await readOptionalUtf8File(workspace.jobOutputPaths.configPath);
    const logOutput = await readOptionalUtf8File(workspace.jobOutputPaths.logPath);
    await removeDirectoryIfExists(workspace.jobWorkdir);

    return {
      ok: false,
      message: "generator_failed",
      jobId: workspace.jobId,
      appId,
      steamAccountId,
      exitCode: error.code,
      signal: error.signal,
      killed: error.killed,
      stdout: error.stdout,
      stderr: error.stderr,
      configIni,
      logOutput,
      parsed: parseGeneratorOutput(error.stdout, error.stderr),
    };
  }

  const configIni = await readOptionalUtf8File(workspace.jobOutputPaths.configPath);
  const logOutput = await readOptionalUtf8File(workspace.jobOutputPaths.logPath);
  await removeDirectoryIfExists(workspace.jobWorkdir);
  const parsedOutput = parseGeneratorOutput(execution.stdout, execution.stderr);
  const parsedConfig = configIni ? parseConfigIni(configIni) : {};

  return {
    ok: true,
    message: "ticket_generated",
    jobId: workspace.jobId,
    appId,
    steamAccountId,
    stdout: execution.stdout,
    stderr: execution.stderr,
    configIni,
    logOutput,
    parsed: {
      steamId: parsedOutput.steamId,
      configSteamUserId: parsedOutput.configSteamUserId || parsedConfig.account_steamid || null,
      ticket: parsedOutput.ticket || parsedConfig.ticket || null,
    },
  };
}

function parseThirdPartyTokenOutput(stdout, stderr) {
  const merged = [stdout, stderr].filter(Boolean).join("\n");
  const tokenContentMatch = merged.match(/Token content:\s*(.+)/i);

  return {
    token: tokenContentMatch ? tokenContentMatch[1].trim() : null,
  };
}

async function executeThirdPartyTokenJob({ tokenReq }) {
  const { exePath, workdir, outputPath, jobsDir } = getThirdPartyTokenGeneratorPaths();
  await fs.access(exePath);
  await fs.access(workdir);

  let workspace = null;

  try {
    workspace = await createIsolatedJobWorkspace({
      exePath,
      workdir,
      outputPaths: {
        tokenPath: outputPath,
      },
      jobsDir,
      exeLabel: "THIRD_PARTY_TOKEN_GENERATOR_EXE_PATH",
      workdirLabel: "THIRD_PARTY_TOKEN_GENERATOR_WORKDIR",
    });
  } catch (error) {
    return {
      ok: false,
      message: "token_workspace_failed",
      error: error.message,
    };
  }

  let execution;

  try {
    execution = await runThirdPartyTokenGenerator({
      exePath: workspace.jobExePath,
      workdir: workspace.jobWorkdir,
      tokenReq,
    });
  } catch (error) {
    const tokenFile = await readOptionalUtf8File(workspace.jobOutputPaths.tokenPath);
    await removeDirectoryIfExists(workspace.jobWorkdir);

    return {
      ok: false,
      message: "token_generator_failed",
      jobId: workspace.jobId,
      exitCode: error.code,
      signal: error.signal,
      killed: error.killed,
      stdout: error.stdout,
      stderr: error.stderr,
      tokenFile,
      parsed: parseThirdPartyTokenOutput(error.stdout, error.stderr),
    };
  }

  const tokenFile = await readOptionalUtf8File(workspace.jobOutputPaths.tokenPath);
  await removeDirectoryIfExists(workspace.jobWorkdir);
  const parsedOutput = parseThirdPartyTokenOutput(execution.stdout, execution.stderr);
  const token = parsedOutput.token || (tokenFile ? tokenFile.trim() : null);

  if (!token) {
    return {
      ok: false,
      message: "token_not_found",
      jobId: workspace.jobId,
      stdout: execution.stdout,
      stderr: execution.stderr,
      tokenFile,
      parsed: parsedOutput,
    };
  }

  return {
    ok: true,
    message: "token_generated",
    jobId: workspace.jobId,
    token,
    stdout: execution.stdout,
    stderr: execution.stderr,
    tokenFile,
    parsed: {
      token,
    },
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    let generatorConfigured = true;
    let generatorError = null;
    let thirdPartyTokenGeneratorConfigured = true;
    let thirdPartyTokenGeneratorError = null;

    try {
      getGeneratorPaths();
    } catch (error) {
      generatorConfigured = false;
      generatorError = error.message;
    }

    try {
      getThirdPartyTokenGeneratorPaths();
    } catch (error) {
      thirdPartyTokenGeneratorConfigured = false;
      thirdPartyTokenGeneratorError = error.message;
    }

    sendJson(res, 200, {
      ok: true,
      message: "worker_alive",
      requiresAuth: Boolean(WORKER_TOKEN),
      generatorConfigured,
      generatorError,
      thirdPartyTokenGeneratorConfigured,
      thirdPartyTokenGeneratorError,
    });
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, {
      ok: false,
      message: "unauthorized",
    });
    return;
  }

  if (req.method === "POST" && req.url === "/ticket-jobs") {
    try {
      const payload = await readJson(req);
      const validationError = validateTicketJobPayload(payload);

      if (validationError) {
        sendJson(res, 400, {
          ok: false,
          message: "invalid_payload",
          error: validationError,
        });
        return;
      }

      const appId = Number(String(payload.appId).trim());
      const steamAccountId = payload.steamAccountId.trim();
      const result = await executeTicketJob({ appId, steamAccountId });

      sendJson(res, result.ok ? 200 : 500, result);
      return;
    } catch (error) {
      const isJsonError = error instanceof SyntaxError;

      sendJson(res, isJsonError ? 400 : 500, {
        ok: false,
        message: isJsonError ? "invalid_json" : "worker_error",
        error: error.message,
      });
      return;
    }
  }

  if (req.method === "POST" && req.url === "/token-jobs-third-party") {
    try {
      const payload = await readJson(req);
      const validationError = validateThirdPartyTokenJobPayload(payload);

      if (validationError) {
        sendJson(res, 400, {
          ok: false,
          message: "invalid_payload",
          error: validationError,
        });
        return;
      }

      const tokenReq = payload.tokenReq.trim();
      const result = await executeThirdPartyTokenJob({ tokenReq });

      sendJson(res, result.ok ? 200 : 500, result);
      return;
    } catch (error) {
      const isJsonError = error instanceof SyntaxError;

      sendJson(res, isJsonError ? 400 : 500, {
        ok: false,
        message: isJsonError ? "invalid_json" : "worker_error",
        error: error.message,
      });
      return;
    }
  }

  sendJson(res, 404, {
    ok: false,
    message: "not_found",
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Merlin worker listening on http://${HOST}:${PORT}`);
});
