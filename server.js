const fs = require("node:fs/promises");
const path = require("path");
const os = require("os");
const { randomUUID } = require("node:crypto");
require("dotenv").config({ path: path.join(__dirname, ".env.local"), quiet: true });
require("dotenv").config({ quiet: true });

const express = require("express");
const cheerio = require("cheerio");
const multer = require("multer");
const OpenAI = require("openai");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const FIRST_BASE_URL = "https://frc-events.firstinspires.org/2026";
const CURRENT_SEASON = 2026;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MATCH_FETCH_CONCURRENCY = 24;
const HISTORY_FILE = path.join(__dirname, "data", "query-history.json");
const TEAM_DIRECTORY_FILE = path.join(__dirname, "data", "team-directory-2026.json");
const HISTORY_LIMIT = 200;
const JOB_TTL_MS = 30 * 60 * 1000;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";
const MAX_AGENT_TURNS = 8;
const STATBOTICS_API_BASE = "https://api.statbotics.io/v3";
const TEAM_DIRECTORY_FILE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TEAM_AVATAR_URL = "/team-avatar-fallback.svg";
const ATTACHMENT_MAX_FILES = 3;
const ATTACHMENT_MAX_FILE_BYTES = 1024 * 1024;
const ATTACHMENT_PER_FILE_CHAR_LIMIT = 6000;
const ATTACHMENT_TOTAL_CHAR_LIMIT = 16000;
const ATTACHMENT_TEAM_QUERY_LIMIT = 80;
const ATTACHMENT_TEAM_FETCH_LIMIT = 60;
const SCORE_QUERY_STOP_WORDS = new Set([
  "what",
  "whats",
  "is",
  "the",
  "top",
  "highest",
  "high",
  "max",
  "maximum",
  "best",
  "score",
  "scores",
  "point",
  "points",
  "in",
  "for",
  "of",
  "at",
  "from",
  "to",
  "this",
  "year",
  "current",
  "currently",
  "minnesota",
  "mn",
  "2026",
  "first",
  "robotics",
  "competition",
  "competitions",
  "frc",
]);
const ALLOWED_RESEARCH_HOSTS = new Set([
  "firstinspires.org",
  "www.firstinspires.org",
  "frc-events.firstinspires.org",
  "thebluealliance.com",
  "www.thebluealliance.com",
  "statbotics.io",
  "www.statbotics.io",
]);
const FIRST_REGIONAL_API = {
  baseUrl: "https://frc-api.firstinspires.org",
  version: "v3.2",
  username: "FRC_RegionalPool ",
  apiKey: "F2057EBA-2E07-40C4-A1A3-D66CDFCA6326",
};

const MINNESOTA_2026_EVENTS = [
  { code: "MNDU", name: "Lake Superior Regional" },
  { code: "MNDU2", name: "Northern Lights Regional" },
  { code: "MNWI", name: "Minnesota Bluff Country Regional" },
  { code: "MNMI", name: "Minnesota 10,000 Lakes Regional" },
  { code: "MNUM", name: "Minnesota North Star Regional" },
  { code: "MNMI2", name: "Minnesota Granite City Regional" },
];
const CHAMPIONSHIP_DIVISIONS = [
  { code: "ARCHIMEDES", name: "Archimedes" },
  { code: "CURIE", name: "Curie" },
  { code: "DALY", name: "Daly" },
  { code: "GALILEO", name: "Galileo" },
  { code: "HOPPER", name: "Hopper" },
  { code: "JOHNSON", name: "Johnson" },
  { code: "MILSTEIN", name: "Milstein" },
  { code: "NEWTON", name: "Newton" },
];
const SPECIAL_EVENT_ALIASES = [
  {
    code: "MNST",
    name: "Minnesota State High School League Championship",
  },
];
const US_STATE_ALIASES = new Map([
  ["alabama", "AL"],
  ["alaska", "AK"],
  ["arizona", "AZ"],
  ["arkansas", "AR"],
  ["california", "CA"],
  ["colorado", "CO"],
  ["connecticut", "CT"],
  ["delaware", "DE"],
  ["district of columbia", "DC"],
  ["dc", "DC"],
  ["florida", "FL"],
  ["georgia", "GA"],
  ["hawaii", "HI"],
  ["idaho", "ID"],
  ["illinois", "IL"],
  ["indiana", "IN"],
  ["iowa", "IA"],
  ["kansas", "KS"],
  ["kentucky", "KY"],
  ["louisiana", "LA"],
  ["maine", "ME"],
  ["maryland", "MD"],
  ["massachusetts", "MA"],
  ["michigan", "MI"],
  ["minnesota", "MN"],
  ["mississippi", "MS"],
  ["missouri", "MO"],
  ["montana", "MT"],
  ["nebraska", "NE"],
  ["nevada", "NV"],
  ["new hampshire", "NH"],
  ["new jersey", "NJ"],
  ["new mexico", "NM"],
  ["new york", "NY"],
  ["north carolina", "NC"],
  ["north dakota", "ND"],
  ["ohio", "OH"],
  ["oklahoma", "OK"],
  ["oregon", "OR"],
  ["pennsylvania", "PA"],
  ["rhode island", "RI"],
  ["south carolina", "SC"],
  ["south dakota", "SD"],
  ["tennessee", "TN"],
  ["texas", "TX"],
  ["utah", "UT"],
  ["vermont", "VT"],
  ["virginia", "VA"],
  ["washington", "WA"],
  ["west virginia", "WV"],
  ["wisconsin", "WI"],
  ["wyoming", "WY"],
]);

const cache = new Map();
const jobs = new Map();
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: ATTACHMENT_MAX_FILES,
    fileSize: ATTACHMENT_MAX_FILE_BYTES,
  },
});
let openaiClient = null;
let historyWriteQueue = Promise.resolve();

app.use(express.json());

app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use(
  express.static(path.join(__dirname, "public"), {
    index: false,
    setHeaders(res, filePath) {
      res.set("Cache-Control", "no-store");
    },
  }),
);

app.get("/api/query", async (req, res) => {
  const question = String(req.query.q || "").trim();

  if (!question) {
    res.status(400).json({
      error: "Missing query text.",
      examples: getSupportedExamples(),
    });
    return;
  }

  try {
    const answer = await answerQuestion(question);
    const archivedAnswer = await archiveAnswer(answer);
    res.json(archivedAnswer);
  } catch (error) {
    res.status(500).json({
      error: "Failed to answer query.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/query-jobs", upload.array("attachments", ATTACHMENT_MAX_FILES), async (req, res) => {
  const question = String(req.body?.question || "").trim();
  const attachmentContext = buildAttachmentContext(req.files || []);

  if (!question) {
    res.status(400).json({
      error: "Missing query text.",
      examples: getSupportedExamples(),
    });
    return;
  }

  if (req.files?.length && attachmentContext.files.every((file) => file.supported === false)) {
    res.status(400).json({
      error: "Unsupported attachment type.",
      detail: "Use text, CSV, TSV, JSON, Markdown, or log files for attachment-based questions.",
    });
    return;
  }

  const job = createQueryJob(question, attachmentContext);
  void runQueryJob(job.id, question, attachmentContext);
  res.status(202).json(getQueryJobSnapshot(job.id));
});

app.get("/api/query-jobs/:id", (req, res) => {
  const snapshot = getQueryJobSnapshot(req.params.id);

  if (!snapshot) {
    res.status(404).json({
      error: "Query job not found.",
    });
    return;
  }

  res.json(snapshot);
});

app.get("/api/query-stream", async (req, res) => {
  const question = String(req.query.q || "").trim();

  if (!question) {
    res.status(400).json({
      error: "Missing query text.",
      examples: getSupportedExamples(),
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const send = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    send("progress", {
      message: "Accepted query.",
      source: null,
    });

    const answer = await answerQuestion(question, {
      onProgress: (progress) => send("progress", progress),
    });
    const archivedAnswer = await archiveAnswer(answer);

    send("result", archivedAnswer);
  } catch (error) {
    send("query-error", {
      error: "Failed to answer query.",
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    res.end();
  }
});

app.get("/api/history", async (_req, res) => {
  try {
    const history = await readHistory();
    res.json(history.map(summarizeHistoryEntry));
  } catch (error) {
    res.status(500).json({
      error: "Failed to load history.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/history/:id", async (req, res) => {
  try {
    const history = await readHistory();
    const entry = history.find((item) => item.id === req.params.id);

    if (!entry) {
      res.status(404).json({
        error: "History entry not found.",
      });
      return;
    }

    res.json(entry);
  } catch (error) {
    res.status(500).json({
      error: "Failed to load history entry.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.delete("/api/history", async (_req, res) => {
  try {
    let originalCount = 0;
    let remainingEntries = [];

    await queueHistoryWrite((history) => {
      originalCount = history.length;
      remainingEntries = pruneHistoryKeepOldest(history);
      return remainingEntries;
    });

    res.json({
      clearedCount: Math.max(0, originalCount - remainingEntries.length),
      remainingCount: remainingEntries.length,
      history: remainingEntries.map(summarizeHistoryEntry),
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to clear history.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

app.use((error, _req, res, next) => {
  if (!(error instanceof multer.MulterError)) {
    next(error);
    return;
  }

  res.status(400).json({
    error: "Attachment upload failed.",
    detail:
      error.code === "LIMIT_FILE_SIZE"
        ? `Each attachment must be ${Math.round(ATTACHMENT_MAX_FILE_BYTES / 1024 / 1024)} MB or smaller.`
        : error.message,
  });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    const lanAddress = getLanAddress();
    console.log(`FIRST query app listening on http://localhost:${PORT}`);
    if (lanAddress) {
      console.log(`LAN URL: http://${lanAddress}:${PORT}`);
    }
  });
}

async function answerQuestion(question, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const attachments = summarizeAttachmentContext(options.attachmentContext);
  const directRegionalPointsTeamQuery = extractRegionalPointsTeamQuery(question);
  const directFirstChampionshipTeamQuery = extractFirstChampionshipTeamQuery(question);
  const directTeamEventMatchupEpaRequest = extractTeamEventMatchupEpaRequest(question);
  const directEventRankingsWithEpaRequest = extractEventRankingsWithEpaRequest(question);
  const directChampionshipDivisionEpaRequest = extractChampionshipDivisionEpaRequest(question);
  const directChampionshipDivisionStandingsRequest =
    extractChampionshipDivisionStandingsRequest(question);
  const directEpaRankingRequest = extractEpaRankingRequest(question);
  const directAttachedEpaRankingRequest = extractAttachedEpaRankingRequest(
    question,
    options.attachmentContext,
  );

  if (directRegionalPointsTeamQuery) {
    onProgress({
      message: `Detected a team-specific regional-points query for "${directRegionalPointsTeamQuery}".`,
      source: null,
    });
    onProgress({
      message: "Routing directly to the Statbotics and official FIRST team-points lookup.",
      source: null,
    });

    const result = await getTeamRegionalPoints2026(
      {
        teamQuery: directRegionalPointsTeamQuery,
      },
      { onProgress },
    );

    const response = {
      supported: result.supported !== false,
      intent: "team_regional_points",
      question,
      answer:
        result.answer ||
        (result.supported === false
          ? `I could not find 2026 regional points for "${directRegionalPointsTeamQuery}".`
          : buildTeamRegionalPointsAnswer(result)),
      sources: sanitizeSourceList(result.sources || []),
      result: result.supported === false ? null : result,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
    };
    response.llmTrace = buildBypassTrace({
      question,
      route: "team_regional_points",
      detail: `Detected "${directRegionalPointsTeamQuery}" as a specific-team regional-points question.`,
      attachments,
      finalPayload: response,
    });
    return response;
  }

  if (directFirstChampionshipTeamQuery) {
    onProgress({
      message: `Detected a FIRST Championship qualification query for "${directFirstChampionshipTeamQuery}".`,
      source: null,
    });
    onProgress({
      message: "Routing directly to the official FIRST regional rankings profile.",
      source: "https://frc-events.firstinspires.org/ra/2026/teams",
    });

    const result = await getTeamRegionalPoints2026(
      {
        teamQuery: directFirstChampionshipTeamQuery,
      },
      { onProgress },
    );

    const response = {
      supported: result.supported !== false,
      intent: "team_first_championship",
      question,
      answer:
        result.answer ||
        (result.supported === false
          ? `I could not determine the 2026 FIRST Championship status for "${directFirstChampionshipTeamQuery}".`
          : buildTeamChampionshipAnswer(result)),
      sources: sanitizeSourceList(result.sources || []),
      result: result.supported === false ? null : result,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
    };
    response.llmTrace = buildBypassTrace({
      question,
      route: "team_first_championship",
      detail: `Detected "${directFirstChampionshipTeamQuery}" as a specific-team FIRST Championship question.`,
      attachments,
      finalPayload: response,
    });
    return response;
  }

  if (directTeamEventMatchupEpaRequest) {
    onProgress({
      message: `Detected a team matchup EPA query for ${directTeamEventMatchupEpaRequest.teamQuery} at ${directTeamEventMatchupEpaRequest.eventCode}.`,
      source: null,
    });
    onProgress({
      message: "Routing directly to the official FIRST team-filtered event schedule and Statbotics EPA data.",
      source: `${FIRST_BASE_URL}/${directTeamEventMatchupEpaRequest.eventCode}`,
    });

    const result = await getTeamEventMatchupEpa2026(
      {
        teamQuery: directTeamEventMatchupEpaRequest.teamQuery,
        eventCode: directTeamEventMatchupEpaRequest.eventCode,
      },
      { onProgress },
    );

    const response = {
      supported: result.supported !== false,
      intent: "team_event_matchup_epa",
      question,
      answer: result.answer || buildTeamEventMatchupEpaAnswer(result),
      sources: sanitizeSourceList(result.sources || []),
      result: result.supported === false ? null : result,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
    };
    response.llmTrace = buildBypassTrace({
      question,
      route: "team_event_matchup_epa",
      detail: `Detected a team-event partner/opponent EPA request for ${directTeamEventMatchupEpaRequest.teamQuery} at ${directTeamEventMatchupEpaRequest.eventCode}.`,
      attachments,
      finalPayload: response,
    });
    return response;
  }

  if (directEventRankingsWithEpaRequest) {
    onProgress({
      message: `Detected an event rankings plus EPA query for ${directEventRankingsWithEpaRequest.eventCode}.`,
      source: null,
    });
    onProgress({
      message: "Routing directly to the official FIRST event rankings plus Statbotics EPA data.",
      source: `${FIRST_BASE_URL}/${directEventRankingsWithEpaRequest.eventCode}/rankings`,
    });

    const result = await getEventRankingsWithEpa2026(
      {
        eventCode: directEventRankingsWithEpaRequest.eventCode,
      },
      { onProgress },
    );

    const response = {
      supported: result.supported !== false,
      intent: "event_rankings_with_epa",
      question,
      answer: result.answer || buildEventRankingsWithEpaAnswer(result),
      sources: sanitizeSourceList(result.sources || []),
      result: result.supported === false ? null : result,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
    };
    response.llmTrace = buildBypassTrace({
      question,
      route: "event_rankings_with_epa",
      detail: `Detected an event rankings with EPA request for ${directEventRankingsWithEpaRequest.eventCode}.`,
      attachments,
      finalPayload: response,
    });
    return response;
  }

  if (directChampionshipDivisionEpaRequest) {
    onProgress({
      message: `Detected a ${directChampionshipDivisionEpaRequest.divisionName} division EPA query.`,
      source: null,
    });
    onProgress({
      message: "Routing directly to the FRC Events API roster plus Statbotics EPA data.",
      source: `${FIRST_BASE_URL}/${directChampionshipDivisionEpaRequest.divisionCode}`,
    });

    const result = await getChampionshipDivisionTeamsByEpa2026(
      {
        divisionCode: directChampionshipDivisionEpaRequest.divisionCode,
        limit: directChampionshipDivisionEpaRequest.limit,
      },
      { onProgress },
    );

    const response = {
      supported: result.supported !== false,
      intent: "championship_division_epa_rankings",
      question,
      answer: result.answer || buildChampionshipDivisionEpaAnswer(result),
      sources: sanitizeSourceList(result.sources || []),
      result: result.supported === false ? null : result,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
    };
    response.llmTrace = buildBypassTrace({
      question,
      route: "championship_division_epa_rankings",
      detail: `Detected a ${directChampionshipDivisionEpaRequest.divisionName} division EPA ranking request.`,
      attachments,
      finalPayload: response,
    });
    return response;
  }

  if (directChampionshipDivisionStandingsRequest) {
    onProgress({
      message: `Detected a ${directChampionshipDivisionStandingsRequest.divisionName} division standings query.`,
      source: null,
    });
    onProgress({
      message: "Routing directly to the FRC Events standings feed and event page.",
      source: `${FIRST_BASE_URL}/${directChampionshipDivisionStandingsRequest.divisionCode}/rankings`,
    });

    const result = await getChampionshipDivisionStandings2026(
      {
        divisionCode: directChampionshipDivisionStandingsRequest.divisionCode,
        limit: directChampionshipDivisionStandingsRequest.limit,
      },
      { onProgress },
    );

    const response = {
      supported: result.supported !== false,
      intent: "championship_division_standings",
      question,
      answer: result.answer || buildChampionshipDivisionStandingsAnswer(result),
      sources: sanitizeSourceList(result.sources || []),
      result: result.supported === false ? null : result,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
    };
    response.llmTrace = buildBypassTrace({
      question,
      route: "championship_division_standings",
      detail: `Detected a ${directChampionshipDivisionStandingsRequest.divisionName} division standings request.`,
      attachments,
      finalPayload: response,
    });
    return response;
  }

  if (directAttachedEpaRankingRequest) {
    onProgress({
      message: `Detected an attached-team EPA rankings query across ${options.attachmentContext.teamQueries.length} extracted team entries.`,
      source: null,
    });

    const result = await getAttachedTeamEpaRankings2026(
      {
        limit: directAttachedEpaRankingRequest.limit,
      },
      {
        attachmentContext: options.attachmentContext,
        onProgress,
      },
    );

    const response = {
      supported: result.supported !== false,
      intent: "attached_team_epa_rankings",
      question,
      answer: result.answer || buildAttachedTeamEpaRankingsAnswer(result),
      sources: sanitizeSourceList(result.sources || []),
      result: result.supported === false ? null : result,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
    };
    response.llmTrace = buildBypassTrace({
      question,
      route: "attached_team_epa_rankings",
      detail: `Detected an attached-file EPA ranking request across ${options.attachmentContext.teamQueries.length} extracted team values.`,
      attachments,
      finalPayload: response,
    });
    return response;
  }

  if (directEpaRankingRequest) {
    onProgress({
      message: "Detected an EPA rankings query.",
      source: null,
    });
    onProgress({
      message: `Routing directly to Statbotics EPA rankings${directEpaRankingRequest.state ? ` for ${directEpaRankingRequest.state}` : ""}.`,
      source: "https://www.statbotics.io/teams",
    });

    const result = await getEpaRankings2026(
      {
        limit: directEpaRankingRequest.limit,
        state: directEpaRankingRequest.state,
      },
      { onProgress },
    );

    const response = {
      supported: result.supported !== false,
      intent: "epa_rankings",
      question,
      answer: result.answer || buildEpaRankingsAnswer(result),
      sources: sanitizeSourceList(result.sources || []),
      result: result.supported === false ? null : result,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
    };
    response.llmTrace = buildBypassTrace({
      question,
      route: "epa_rankings",
      detail: `Detected an EPA rankings request${directEpaRankingRequest.state ? ` filtered to ${directEpaRankingRequest.state}` : ""}.`,
      attachments,
      finalPayload: response,
    });
    return response;
  }

  onProgress({
    message: `Submitting question to ${OPENAI_MODEL}.`,
    source: null,
  });

  return answerQuestionWithOpenAI(question, {
    onProgress,
    attachmentContext: options.attachmentContext,
  });
}

function createQueryJob(question, attachmentContext = null) {
  cleanupJobs();

  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    question,
    attachments: summarizeAttachmentContext(attachmentContext),
    status: "queued",
    createdAt: now,
    updatedAt: now,
    progress: [
      {
        at: now,
        message: "Job created.",
        source: null,
      },
    ],
    result: null,
    error: null,
  };

  jobs.set(job.id, job);
  return job;
}

async function runQueryJob(jobId, question, attachmentContext = null) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  updateJob(jobId, {
    status: "running",
  });
  appendJobProgress(jobId, "Starting query.");

  try {
    const answer = await answerQuestion(question, {
      attachmentContext,
      onProgress: (progress) => appendJobProgress(jobId, progress.message, progress.source),
    });
    const archivedAnswer = await archiveAnswer(answer);

    updateJob(jobId, {
      status: "completed",
      result: archivedAnswer,
    });
    appendJobProgress(jobId, `Query completed. Archived as ${archivedAnswer.id}.`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    updateJob(jobId, {
      status: "error",
      error: detail,
    });
    appendJobProgress(jobId, `Query failed: ${detail}`);
  }
}

function getQueryJobSnapshot(jobId) {
  const job = jobs.get(jobId);

  if (!job) {
    return null;
  }

  return {
    id: job.id,
    question: job.question,
    attachments: job.attachments,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    progress: job.progress,
    result: job.result,
    error: job.error,
  };
}

function appendJobProgress(jobId, message, source = null) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  const now = new Date().toISOString();
  job.progress.push({
    at: now,
    message,
    source,
  });
  job.progress = job.progress.slice(-40);
  job.updatedAt = now;
}

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  Object.assign(job, patch, {
    updatedAt: new Date().toISOString(),
  });
}

function cleanupJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;

  for (const [jobId, job] of jobs.entries()) {
    if (new Date(job.updatedAt).getTime() < cutoff) {
      jobs.delete(jobId);
    }
  }
}

async function archiveAnswer(answer) {
  const entry = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...answer,
  };

  await queueHistoryWrite((history) => [entry, ...history].slice(0, HISTORY_LIMIT));
  return entry;
}

function parseQuestion(question) {
  const normalized = question.toLowerCase();
  const yearMatch = normalized.match(/\b20\d{2}\b/);
  const season = yearMatch ? Number(yearMatch[0]) : normalized.includes("this year") ? CURRENT_SEASON : null;
  const asksHighest = /\b(highest|max|maximum|top)\b/.test(normalized);
  const asksAuto = /\b(auto|autonomous)\b/.test(normalized);
  const asksMinnesota = /\bminnesota\b/.test(normalized) || /\bmn\b/.test(normalized);

  if (asksHighest && asksAuto && asksMinnesota && (!season || season === CURRENT_SEASON)) {
    return {
      intent: "highest_auto_score",
      season: CURRENT_SEASON,
      region: "Minnesota",
    };
  }

  return { intent: "unsupported" };
}

function getSupportedExamples() {
  return [
    "What is the highest auto score in FIRST robotics competitions in Minnesota this year, 2026?",
    "Highest autonomous score in Minnesota FRC events in 2026",
    "What are the top 20 teams ranked in regions, by regional points?",
    "Which Minnesota team has the best 2026 regional ranking so far?",
    "Which Minnesota teams have the best EPA in 2026?",
    "Sort all the teams in the Curie division this year by EPA.",
    "Give me a snapshot of the current Curie division standings.",
    "Show the EPA of 7028's partners and opponents in the Minnesota state championship, match by match.",
    "Sort the attached list of teams by EPA.",
    "What is the team number for Iron Mosquitos?",
    "Is Iron Mosquitos going to worlds?",
  ];
}

function buildAttachmentContext(files = []) {
  const normalizedFiles = [];
  const textBlocks = [];
  const teamQuerySet = new Set();
  let totalChars = 0;

  for (const file of files.slice(0, ATTACHMENT_MAX_FILES)) {
    const parsedFile = parseUploadedAttachment(file);
    normalizedFiles.push(parsedFile);

    for (const teamQuery of parsedFile.teamQueries || []) {
      const normalizedQuery = cleanTeamQuery(teamQuery);
      if (normalizedQuery) {
        teamQuerySet.add(normalizedQuery);
      }
    }

    if (!parsedFile.textPreview) {
      continue;
    }

    const remainingChars = ATTACHMENT_TOTAL_CHAR_LIMIT - totalChars;
    if (remainingChars <= 0) {
      break;
    }

    const block = `File: ${parsedFile.name}\n${parsedFile.textPreview.slice(0, remainingChars)}`;
    textBlocks.push(block);
    totalChars += block.length;
  }

  return {
    fileCount: normalizedFiles.length,
    files: normalizedFiles,
    combinedText: textBlocks.join("\n\n"),
    teamQueries: Array.from(teamQuerySet).slice(0, ATTACHMENT_TEAM_QUERY_LIMIT),
  };
}

function parseUploadedAttachment(file) {
  const name = normalizeText(file?.originalname || "attachment");
  const mimeType = normalizeText(file?.mimetype || "application/octet-stream");
  const extension = path.extname(name).toLowerCase();
  const supported = isSupportedAttachmentType(mimeType, extension);
  const buffer = Buffer.isBuffer(file?.buffer) ? file.buffer : Buffer.alloc(0);
  const rawText = supported ? normalizeAttachmentText(buffer.toString("utf8")) : "";
  const textPreview = rawText.slice(0, ATTACHMENT_PER_FILE_CHAR_LIMIT);

  return {
    name,
    mimeType,
    size: Number(file?.size) || buffer.length,
    supported,
    truncated: rawText.length > ATTACHMENT_PER_FILE_CHAR_LIMIT,
    textPreview,
    teamQueries: supported ? extractTeamQueriesFromAttachmentText(textPreview) : [],
  };
}

function summarizeAttachmentContext(context) {
  if (!context || !Array.isArray(context.files) || context.files.length === 0) {
    return [];
  }

  return context.files.map((file) => ({
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    supported: file.supported !== false,
    teamQueryCount: Array.isArray(file.teamQueries) ? file.teamQueries.length : 0,
    truncated: Boolean(file.truncated),
  }));
}

function isSupportedAttachmentType(mimeType, extension) {
  return (
    /^text\//i.test(mimeType) ||
    [
      "application/json",
      "application/x-ndjson",
      "application/xml",
      "text/csv",
      "text/tab-separated-values",
    ].includes(mimeType) ||
    [".txt", ".csv", ".tsv", ".json", ".md", ".markdown", ".log"].includes(extension)
  );
}

function normalizeAttachmentText(value) {
  return String(value || "")
    .replace(/\u0000/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function extractTeamQueriesFromAttachmentText(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const candidates = [];
  let preferredColumns = null;

  for (const [index, line] of lines.entries()) {
    const cells = splitAttachmentCells(line);
    if (index === 0) {
      preferredColumns = findAttachmentTeamColumns(cells);
      if (preferredColumns.length > 0) {
        continue;
      }
    }

    const scanValues =
      preferredColumns && preferredColumns.length > 0
        ? preferredColumns.map((columnIndex) => cells[columnIndex]).filter(Boolean)
        : cells.length > 1
          ? cells
          : [line];

    for (const value of scanValues) {
      const candidate = normalizeAttachmentTeamCandidate(value);
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  return dedupeStrings(candidates).slice(0, ATTACHMENT_TEAM_QUERY_LIMIT);
}

function splitAttachmentCells(line) {
  return String(line || "")
    .split(/\t|,|;|\|/)
    .map((cell) => normalizeText(cell.replace(/^["']|["']$/g, "")))
    .filter(Boolean);
}

function findAttachmentTeamColumns(cells) {
  return cells
    .map((cell, index) => ({
      index,
      value: normalizeSearchText(cell),
    }))
    .filter(
      (cell) =>
        cell.value === "team" ||
        cell.value === "team number" ||
        cell.value === "number" ||
        cell.value === "team name" ||
        cell.value === "name",
    )
    .map((cell) => cell.index);
}

function normalizeAttachmentTeamCandidate(value) {
  let normalized = normalizeText(value)
    .replace(/^[-*•]+\s*/, "")
    .replace(/^\d+[.)-]\s*/, "")
    .replace(/^team\s*#?\s*/i, "team ");

  if (!normalized) {
    return null;
  }

  const normalizedSearch = normalizeSearchText(normalized);
  if (
    !normalizedSearch ||
    [
      "team",
      "team number",
      "number",
      "name",
      "notes",
      "note",
      "city",
      "state",
      "location",
      "district",
      "school",
      "epa",
      "rank",
    ].includes(normalizedSearch)
  ) {
    return null;
  }

  const numericMatch = normalized.match(/^(?:team\s+)?(\d{1,5})$/i);
  if (numericMatch) {
    return numericMatch[1];
  }

  if (/\d{1,5}/.test(normalized) && normalized.length <= 12) {
    const embeddedNumber = normalized.match(/\b(\d{1,5})\b/);
    if (embeddedNumber) {
      return embeddedNumber[1];
    }
  }

  if (!/[a-z]/i.test(normalized) || normalized.length > 80) {
    return null;
  }

  return normalized;
}

function dedupeStrings(values) {
  const seen = new Set();
  const deduped = [];

  for (const value of values || []) {
    const normalized = normalizeSearchText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(value);
  }

  return deduped;
}

function extractAttachedEpaRankingRequest(question, attachmentContext) {
  if (!attachmentContext?.teamQueries?.length) {
    return null;
  }

  const normalized = String(question || "").toLowerCase();
  const mentionsAttachment = /\b(attached|attachment|upload|uploaded|file|list)\b/.test(normalized);
  const mentionsEpa = /\bepa\b/.test(normalized);
  const asksForRanking = /\b(sort|sorted|rank|ranking|best|top|highest|order)\b/.test(normalized);

  if (!mentionsEpa || !asksForRanking || !mentionsAttachment) {
    return null;
  }

  return {
    limit: extractRequestedLimit(question, attachmentContext.teamQueries.length, ATTACHMENT_TEAM_FETCH_LIMIT),
  };
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is not set. Set it in the environment before starting the app.",
    );
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return openaiClient;
}

async function answerQuestionWithOpenAI(question, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const client = getOpenAIClient();
  const attachments = summarizeAttachmentContext(options.attachmentContext);
  const systemPrompt = buildSystemPrompt(options.attachmentContext);
  const llmTrace = {
    mode: "llm",
    bypassed: false,
    model: OPENAI_MODEL,
    question,
    attachments,
    systemPrompt,
    toolCalls: [],
    finalReturnAnswer: null,
    fallback: null,
  };
  let lastStructuredResult = null;
  let discoveredSources = [];
  let lastToolAnswer = "";
  let lastToolSupported = false;

  let response = await client.responses.create({
    model: OPENAI_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: systemPrompt,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: question,
          },
          ...(buildAttachmentUserContent(options.attachmentContext)
            ? [
                {
                  type: "input_text",
                  text: buildAttachmentUserContent(options.attachmentContext),
                },
              ]
            : []),
        ],
      },
    ],
    tools: getOpenAITools(),
    parallel_tool_calls: false,
  });

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
    const toolCalls = (response.output || []).filter((item) => item.type === "function_call");

    if (toolCalls.length === 0) {
      if (response.output_text) {
        return {
          supported: true,
          intent: "llm_research",
          question,
          answer: response.output_text,
          sources: discoveredSources,
          result: lastStructuredResult,
          examples: getSupportedExamples(),
          model: OPENAI_MODEL,
          attachments,
          llmTrace: {
            ...llmTrace,
            finalResponseText: response.output_text,
          },
        };
      }

      throw new Error("The model did not return an answer.");
    }

    const toolOutputs = [];

    for (const toolCall of toolCalls) {
      const args = parseToolArguments(toolCall.arguments);
      llmTrace.toolCalls.push({
        turn: turn + 1,
        name: toolCall.name,
        arguments: args,
      });
      onProgress({
        message: `GPT requested tool: ${toolCall.name}.`,
        source: null,
      });

      if (toolCall.name === "return_answer") {
        llmTrace.finalReturnAnswer = args;
        return finalizeReturnAnswer(question, args, {
          fallbackResult: lastStructuredResult,
          fallbackSources: discoveredSources,
          attachments,
          llmTrace,
        });
      }

      const output = await runAgentTool(toolCall.name, args, {
        onProgress,
        attachmentContext: options.attachmentContext,
      });
      if (output?.structuredResult) {
        lastStructuredResult = output.structuredResult;
      }
      if (Array.isArray(output?.sources) && output.sources.length > 0) {
        discoveredSources = mergeSourceLists(discoveredSources, output.sources);
      }
      if (typeof output?.answer === "string" && output.answer.trim()) {
        lastToolAnswer = output.answer.trim();
      }
      if (typeof output?.supported === "boolean") {
        lastToolSupported = output.supported;
      }
      toolOutputs.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: JSON.stringify(output),
      });
    }

    response = await client.responses.create({
      model: OPENAI_MODEL,
      previous_response_id: response.id,
      input: toolOutputs,
      tools: getOpenAITools(),
      parallel_tool_calls: false,
    });
  }

  onProgress({
    message: "GPT reached the tool-turn limit. Using the strongest grounded fallback available.",
    source: null,
  });
  llmTrace.fallback = {
    reason: "tool_turn_limit",
  };

  const directMetricQuery = extractMetricQuery(question);
  const directRegionalPointsTeamQuery = extractRegionalPointsTeamQuery(question);
  const directTeamLookupName = extractTeamLookupName(question);
  const directEpaRankingRequest = extractEpaRankingRequest(question);
  const directAttachedEpaRankingRequest = extractAttachedEpaRankingRequest(
    question,
    options.attachmentContext,
  );
  const asksMinnesota = /\bminnesota\b|\bmn\b/i.test(question);
  const asksScore = /\bscore|points?\b/i.test(question);
  if (directRegionalPointsTeamQuery) {
    onProgress({
      message: `Running direct team regional-points fallback for "${directRegionalPointsTeamQuery}".`,
      source: null,
    });
    const fallback = await getTeamRegionalPoints2026(
      { teamQuery: directRegionalPointsTeamQuery },
      { onProgress },
    );
    return {
      supported: fallback.supported !== false,
      intent: "llm_research",
      question,
      answer:
        fallback.answer ||
        (fallback.supported === false
          ? `I could not find 2026 regional points for "${directRegionalPointsTeamQuery}".`
          : buildTeamRegionalPointsAnswer(fallback)),
      sources: sanitizeSourceList(fallback.sources || discoveredSources),
      result: fallback.supported === false ? null : fallback,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
      llmTrace: {
        ...llmTrace,
        fallback: {
          reason: "tool_turn_limit",
          route: "team_regional_points",
        },
      },
    };
  }

  if (asksMinnesota && asksScore && directMetricQuery) {
    onProgress({
      message: `Running direct Minnesota score fallback for "${directMetricQuery}".`,
      source: null,
    });
    const fallback = await getMinnesotaScoreCategoryMax2026(
      { metricQuery: directMetricQuery },
      { onProgress },
    );
    return {
      supported: fallback.supported !== false,
      intent: "llm_research",
      question,
      answer:
        fallback.answer ||
        (fallback.supported === false
          ? `I could not find an official Minnesota 2026 score row matching "${directMetricQuery}".`
          : buildScoreCategoryAnswer(fallback)),
      sources: sanitizeSourceList(fallback.sources || discoveredSources),
      result: fallback.supported === false ? null : fallback,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
      llmTrace: {
        ...llmTrace,
        fallback: {
          reason: "tool_turn_limit",
          route: "minnesota_score_category",
        },
      },
    };
  }

  if (directTeamLookupName) {
    onProgress({
      message: `Running direct team lookup fallback for "${directTeamLookupName}".`,
      source: null,
    });
    const fallback = await findTeamByName2026(
      { query: directTeamLookupName },
      { onProgress },
    );
    return {
      supported: fallback.supported !== false,
      intent: "llm_research",
      question,
      answer:
        fallback.answer ||
        (fallback.supported === false
          ? `I could not find a 2026 FIRST team matching "${directTeamLookupName}".`
          : buildTeamLookupAnswer(fallback)),
      sources: sanitizeSourceList(fallback.sources || discoveredSources),
      result: null,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
      llmTrace: {
        ...llmTrace,
        fallback: {
          reason: "tool_turn_limit",
          route: "team_lookup",
        },
      },
    };
  }

  if (directAttachedEpaRankingRequest) {
    onProgress({
      message: "Running direct attached-team EPA fallback.",
      source: null,
    });
    const fallback = await getAttachedTeamEpaRankings2026(
      {
        limit: directAttachedEpaRankingRequest.limit,
      },
      {
        attachmentContext: options.attachmentContext,
        onProgress,
      },
    );
    return {
      supported: fallback.supported !== false,
      intent: "llm_research",
      question,
      answer: fallback.answer || buildAttachedTeamEpaRankingsAnswer(fallback),
      sources: sanitizeSourceList(fallback.sources || discoveredSources),
      result: fallback.supported === false ? null : fallback,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
      llmTrace: {
        ...llmTrace,
        fallback: {
          reason: "tool_turn_limit",
          route: "attached_team_epa_rankings",
        },
      },
    };
  }

  if (directEpaRankingRequest) {
    onProgress({
      message: "Running direct EPA rankings fallback.",
      source: null,
    });
    const fallback = await getEpaRankings2026(
      {
        limit: directEpaRankingRequest.limit,
        state: directEpaRankingRequest.state,
      },
      { onProgress },
    );
    return {
      supported: fallback.supported !== false,
      intent: "llm_research",
      question,
      answer: fallback.answer || buildEpaRankingsAnswer(fallback),
      sources: sanitizeSourceList(fallback.sources || discoveredSources),
      result: fallback.supported === false ? null : fallback,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
      llmTrace: {
        ...llmTrace,
        fallback: {
          reason: "tool_turn_limit",
          route: "epa_rankings",
        },
      },
    };
  }

  if (lastToolAnswer) {
    return {
      supported: lastToolSupported || Boolean(lastStructuredResult || discoveredSources.length),
      intent: "llm_research",
      question,
      answer: lastToolAnswer,
      sources: discoveredSources,
      result: lastStructuredResult,
      examples: getSupportedExamples(),
      model: OPENAI_MODEL,
      attachments,
      llmTrace,
    };
  }

  return {
    supported: false,
    intent: "llm_research",
    question,
    answer:
      "I could not complete that query reliably from the available public sources before GPT hit its tool-turn limit. Try a more specific scoring term such as auto, tower, teleop, or regional points.",
    sources: discoveredSources,
    result: lastStructuredResult,
    examples: getSupportedExamples(),
    model: OPENAI_MODEL,
    attachments,
    llmTrace,
  };
}

function buildSystemPrompt(attachmentContext = null) {
  return [
    "You are a FIRST Robotics research assistant inside a local web app.",
    `Today's date is ${new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "long", day: "numeric" })}.`,
    `Every question must be processed with ${OPENAI_MODEL}. Do not answer from memory alone.`,
    ...(attachmentContext?.files?.length
      ? [
          "The user attached one or more local files. Treat the extracted attachment text as user-provided context.",
          "If the user asks to sort or rank the attached team list by EPA, call get_attached_team_epa_rankings_2026 first.",
        ]
      : []),
    "Research process:",
    "1. Prefer official FIRST sources first, then The Blue Alliance, then Statbotics.",
    "2. Use suggest_source_urls to get likely starting points.",
    "3. If the question asks for regional points for a specific team, call get_team_regional_points_2026 first.",
    "4. If the question asks whether a specific team is going to the FIRST Championship or worlds, call get_team_regional_points_2026 first and use the FIRST Championship status from that result.",
    "5. If the question is about regional points, regional pool rankings, or top teams ranked in regions, call get_regional_points_rankings_2026 before using fetch_allowed_url.",
    "6. If the question is about regional points at a specific event, call get_regional_event_points_2026.",
    "7. If the question asks for a team number or asks you to identify a team by name, call find_team_by_name_2026 before using web search or fetch_allowed_url.",
    "8. For specific-team questions, use Statbotics as one of the lookup sources when available.",
    "9. If the question asks for EPA rankings, best EPA teams, or teams sorted by EPA, call get_epa_rankings_2026 first.",
    "10. If the question asks for a FIRST Championship division such as Curie, Hopper, or Newton and wants those teams sorted by EPA, call get_championship_division_epa_rankings_2026 first.",
    "11. If the question asks for a team's partners or opponents at a specific event and wants their EPA match by match, call get_team_event_matchup_epa_2026 first.",
    "12. If the question asks for current event rankings or standings with EPA included for a specific event, call get_event_rankings_with_epa_2026 first.",
    "13. If the question asks for a FIRST Championship division standings snapshot, call get_championship_division_standings_2026 first.",
    "14. If the question refers to attached teams or an attached team list and asks for EPA sorting or ranking, call get_attached_team_epa_rankings_2026 first.",
    "15. Use web_search if needed for discovery, preferably with site: filters targeting the allowed robotics domains.",
    "16. Use fetch_allowed_url to inspect specific pages only when a dedicated tool is not available.",
    "17. Use get_minnesota_auto_max_2026 if the question is about the highest autonomous score in Minnesota for 2026.",
    '18. If the question asks for the highest Minnesota score in 2026 for a score category like "tower", "teleop", "foul", or "auto", call get_minnesota_score_max_2026 with that category text.',
    "19. Once a dedicated tool gives enough evidence, stop researching and call return_answer immediately.",
    "20. If you cannot fully answer the question, still call return_answer with supported=false instead of continuing to loop.",
    "Requirements for return_answer:",
    "- answer: concise but complete.",
    "- sources: array of objects with label and url.",
    "- structured_result: copy the structured result from the most relevant tool when one is available.",
    "- supported: true if you could produce a meaningful answer, false if you could only explain the limitation.",
    "Only reference URLs from these domains in sources when possible:",
    Array.from(ALLOWED_RESEARCH_HOSTS).join(", "),
    "If the user asks for rankings, current season details, or current points, prefer exact current-season pages and include dates explicitly.",
  ].join("\n");
}

function buildAttachmentUserContent(attachmentContext = null) {
  if (!attachmentContext?.files?.length) {
    return "";
  }

  const fileLines = attachmentContext.files.map((file) => {
    const details = [
      file.name,
      file.supported === false ? "unsupported-type" : null,
      file.teamQueries?.length ? `${file.teamQueries.length} extracted team entries` : null,
      file.truncated ? "truncated preview" : null,
    ]
      .filter(Boolean)
      .join(" | ");
    return `- ${details}`;
  });

  return [
    "Attachment context:",
    ...fileLines,
    attachmentContext.teamQueries?.length
      ? `Extracted team entries: ${attachmentContext.teamQueries.join(", ")}`
      : "No team entries were extracted from the attached files.",
    attachmentContext.combinedText ? `Attachment text preview:\n${attachmentContext.combinedText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function getOpenAITools() {
  return [
    { type: "web_search" },
    {
      type: "function",
      name: "suggest_source_urls",
      description:
        "Return likely starting URLs for a FIRST Robotics question, prioritized across official FIRST, The Blue Alliance, and Statbotics.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string" },
        },
        required: ["question"],
      },
    },
    {
      type: "function",
      name: "fetch_allowed_url",
      description:
        "Fetch and summarize a page from an allowed robotics domain. Returns title, extracted text, and discovered links.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
    },
    {
      type: "function",
      name: "get_minnesota_auto_max_2026",
      description:
        "Compute the highest autonomous score in Minnesota FRC events for the 2026 season from official FIRST event pages.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      strict: true,
    },
    {
      type: "function",
      name: "get_minnesota_score_max_2026",
      description:
        'Compute the highest Minnesota FRC score in 2026 for a match-page scoring category such as "tower", "auto tower", "teleop", "foul", or "autonomous".',
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          metric_query: {
            type: "string",
          },
        },
        required: ["metric_query"],
      },
    },
    {
      type: "function",
      name: "find_team_by_name_2026",
      description:
        "Look up a 2026 FIRST Robotics team by team name or nickname using the official FIRST all-teams page.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
          },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "get_team_regional_points_2026",
      description:
        "Get the current 2026 official FIRST regional points for one specific team, using Statbotics to resolve the team identity when possible.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          team_query: {
            type: "string",
          },
        },
        required: ["team_query"],
      },
    },
    {
      type: "function",
      name: "get_regional_points_rankings_2026",
      description:
        "Get the current 2026 FIRST regional pool rankings by regional points, optionally filtered to Minnesota teams.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
          },
          minnesota_only: {
            type: "boolean",
          },
        },
      },
    },
    {
      type: "function",
      name: "get_regional_event_points_2026",
      description:
        "Get the 2026 FIRST regional-points standings for a specific event code, such as MNMI or MNMI2.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          event_code: {
            type: "string",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
          },
        },
        required: ["event_code"],
      },
    },
    {
      type: "function",
      name: "get_epa_rankings_2026",
      description:
        "Get 2026 Statbotics EPA rankings for FRC teams, optionally filtered to a US state such as MN for Minnesota.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
          },
          state: {
            type: ["string", "null"],
            description: "Optional two-letter US state code or full state name, such as MN or Minnesota.",
          },
        },
      },
    },
    {
      type: "function",
      name: "get_championship_division_epa_rankings_2026",
      description:
        "Get the current 2026 EPA rankings for all teams competing in one FIRST Championship division such as CURIE, HOPPER, or NEWTON.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          division_code: {
            type: "string",
            description: "FIRST Championship division event code, such as CURIE.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
          },
        },
        required: ["division_code"],
      },
    },
    {
      type: "function",
      name: "get_championship_division_standings_2026",
      description:
        "Get the current 2026 standings snapshot for one FIRST Championship division such as CURIE, including the pre-event status if rankings are not live yet.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          division_code: {
            type: "string",
            description: "FIRST Championship division event code, such as CURIE.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
          },
        },
        required: ["division_code"],
      },
    },
    {
      type: "function",
      name: "get_team_event_matchup_epa_2026",
      description:
        "Get one team's partners and opponents, match by match, for a specific 2026 event, enriched with current Statbotics EPA values.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          team_query: {
            type: "string",
          },
          event_code: {
            type: "string",
            description: "FIRST event code, such as MNST.",
          },
        },
        required: ["team_query", "event_code"],
      },
    },
    {
      type: "function",
      name: "get_event_rankings_with_epa_2026",
      description:
        "Get the current rankings table for a specific 2026 event, enriched with current Statbotics EPA values for each team.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          event_code: {
            type: "string",
            description: "FIRST event code, such as MNST.",
          },
        },
        required: ["event_code"],
      },
    },
    {
      type: "function",
      name: "get_attached_team_epa_rankings_2026",
      description:
        "Sort the uploaded team list by 2026 Statbotics EPA, using the team numbers or names extracted from the attached files.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: ATTACHMENT_TEAM_FETCH_LIMIT,
          },
        },
      },
    },
    {
      type: "function",
      name: "return_answer",
      description: "Return the final grounded answer for the user.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          supported: { type: "boolean" },
          answer: { type: "string" },
          sources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string" },
                url: { type: "string" },
              },
              required: ["label", "url"],
            },
          },
          structured_result: {
            anyOf: [
              { type: "null" },
              { type: "object" },
            ],
          },
        },
        required: ["supported", "answer", "sources", "structured_result"],
      },
    },
  ];
}

async function runAgentTool(name, args, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const attachmentContext = options.attachmentContext || null;

  if (name === "suggest_source_urls") {
    return suggestSourceUrls(args.question);
  }

  if (name === "fetch_allowed_url") {
    return fetchAllowedUrl(args.url, { onProgress });
  }

  if (name === "get_minnesota_auto_max_2026") {
    const result = await getMinnesotaAutoMax2026({ onProgress });
    return {
      supported: true,
      answer: buildAnswerText(result),
      structuredResult: result,
      sources: result.sources,
    };
  }

  if (name === "get_minnesota_score_max_2026") {
    const result = await getMinnesotaScoreCategoryMax2026(
      {
        metricQuery: args.metric_query,
      },
      { onProgress },
    );
    return {
      supported: result.supported !== false,
      answer:
        result.answer ||
        (result.supported === false ? "" : buildScoreCategoryAnswer(result)),
      structuredResult: result.supported === false ? null : result,
      sources: result.sources,
    };
  }

  if (name === "find_team_by_name_2026") {
    const result = await findTeamByName2026(
      {
        query: args.query,
      },
      { onProgress },
    );
    return {
      supported: result.supported !== false,
      answer:
        result.answer ||
        (result.supported === false ? "" : buildTeamLookupAnswer(result)),
      structuredResult: null,
      sources: result.sources,
    };
  }

  if (name === "get_team_regional_points_2026") {
    const result = await getTeamRegionalPoints2026(
      {
        teamQuery: args.team_query,
      },
      { onProgress },
    );
    return {
      supported: result.supported !== false,
      answer:
        result.answer ||
        (result.supported === false ? "" : buildTeamRegionalPointsAnswer(result)),
      structuredResult: result.supported === false ? null : result,
      sources: result.sources,
    };
  }

  if (name === "get_regional_points_rankings_2026") {
    const result = await getRegionalPointsRankings2026(
      {
        limit: args.limit,
        minnesotaOnly: args.minnesota_only,
      },
      { onProgress },
    );
    return {
      supported: true,
      answer: buildRegionalRankingsAnswer(result),
      structuredResult: result,
      sources: result.sources,
    };
  }

  if (name === "get_regional_event_points_2026") {
    const result = await getRegionalEventPoints2026(
      {
        eventCode: args.event_code,
        limit: args.limit,
      },
      { onProgress },
    );
    return {
      supported: true,
      answer: buildRegionalEventAnswer(result),
      structuredResult: result,
      sources: result.sources,
    };
  }

  if (name === "get_epa_rankings_2026") {
    const result = await getEpaRankings2026(
      {
        limit: args.limit,
        state: args.state,
      },
      { onProgress },
    );
    return {
      supported: result.supported !== false,
      answer: result.answer || buildEpaRankingsAnswer(result),
      structuredResult: result.supported === false ? null : result,
      sources: result.sources,
    };
  }

  if (name === "get_championship_division_epa_rankings_2026") {
    const result = await getChampionshipDivisionTeamsByEpa2026(
      {
        divisionCode: args.division_code,
        limit: args.limit,
      },
      { onProgress },
    );
    return {
      supported: result.supported !== false,
      answer:
        result.answer ||
        (result.supported === false ? "" : buildChampionshipDivisionEpaAnswer(result)),
      structuredResult: result.supported === false ? null : result,
      sources: result.sources,
    };
  }

  if (name === "get_championship_division_standings_2026") {
    const result = await getChampionshipDivisionStandings2026(
      {
        divisionCode: args.division_code,
        limit: args.limit,
      },
      { onProgress },
    );
    return {
      supported: result.supported !== false,
      answer:
        result.answer ||
        (result.supported === false ? "" : buildChampionshipDivisionStandingsAnswer(result)),
      structuredResult: result.supported === false ? null : result,
      sources: result.sources,
    };
  }

  if (name === "get_team_event_matchup_epa_2026") {
    const result = await getTeamEventMatchupEpa2026(
      {
        teamQuery: args.team_query,
        eventCode: args.event_code,
      },
      { onProgress },
    );
    return {
      supported: result.supported !== false,
      answer:
        result.answer ||
        (result.supported === false ? "" : buildTeamEventMatchupEpaAnswer(result)),
      structuredResult: result.supported === false ? null : result,
      sources: result.sources,
    };
  }

  if (name === "get_event_rankings_with_epa_2026") {
    const result = await getEventRankingsWithEpa2026(
      {
        eventCode: args.event_code,
      },
      { onProgress },
    );
    return {
      supported: result.supported !== false,
      answer:
        result.answer ||
        (result.supported === false ? "" : buildEventRankingsWithEpaAnswer(result)),
      structuredResult: result.supported === false ? null : result,
      sources: result.sources,
    };
  }

  if (name === "get_attached_team_epa_rankings_2026") {
    const result = await getAttachedTeamEpaRankings2026(
      {
        limit: args.limit,
      },
      {
        attachmentContext,
        onProgress,
      },
    );
    return {
      supported: result.supported !== false,
      answer:
        result.answer ||
        (result.supported === false ? "" : buildAttachedTeamEpaRankingsAnswer(result)),
      structuredResult: result.supported === false ? null : result,
      sources: result.sources,
    };
  }

  throw new Error(`Unknown tool requested: ${name}`);
}

function finalizeReturnAnswer(question, args, defaults = {}) {
  const structuredResult =
    normalizeStructuredResult(args.structured_result) ||
    normalizeStructuredResult(defaults.fallbackResult);
  return {
    supported: Boolean(args.supported),
    intent: "llm_research",
    question,
    answer: String(args.answer || "").trim(),
    sources: mergeSourceLists(defaults.fallbackSources || [], args.sources || []),
    result: structuredResult,
    examples: getSupportedExamples(),
    model: OPENAI_MODEL,
    attachments: defaults.attachments || [],
    llmTrace: defaults.llmTrace || null,
  };
}

function parseToolArguments(value) {
  if (!value) {
    return {};
  }

  if (typeof value === "string") {
    return JSON.parse(value);
  }

  return value;
}

function sanitizeSourceList(sources) {
  return dedupeByUrl(
    sources
      .map((source) => ({
        label: String(source.label || "").trim(),
        url: String(source.url || "").trim(),
      }))
      .filter((source) => source.label && source.url),
  );
}

function normalizeStructuredResult(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value;
}

function buildBypassTrace(input = {}) {
  return {
    mode: "bypass",
    bypassed: true,
    model: null,
    question: input.question || "",
    attachments: input.attachments || [],
    route: input.route || "unknown",
    detail: input.detail || "",
    systemPrompt: null,
    toolCalls: [],
    finalPayload: buildTracePayloadSnapshot(input.finalPayload),
  };
}

function buildTracePayloadSnapshot(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  return {
    supported: Boolean(payload.supported),
    intent: payload.intent || null,
    answer: String(payload.answer || "").trim(),
    sourceCount: Array.isArray(payload.sources) ? payload.sources.length : 0,
    resultType: payload.result?.type || null,
  };
}

function suggestSourceUrls(question) {
  const normalized = String(question || "").toLowerCase();
  const candidates = [];

  candidates.push({
    label: "2026 FIRST event list",
    url: `${FIRST_BASE_URL}/Events/EventList`,
  });
  candidates.push({
    label: "2026 FIRST regional rankings",
    url: "https://frc-events.firstinspires.org/ra/2026/teams",
  });
  candidates.push({
    label: "FIRST team and event search",
    url: "https://www.firstinspires.org/team-event-search?season=2026&country=United+States",
  });
  candidates.push({
    label: "The Blue Alliance teams",
    url: "https://www.thebluealliance.com/teams",
  });
  candidates.push({
    label: "The Blue Alliance insights",
    url: "https://www.thebluealliance.com/insights",
  });
  candidates.push({
    label: "Statbotics teams",
    url: "https://www.statbotics.io/teams",
  });

  if (/\bregional point|regional ranking|ranked in regions|regional points\b/.test(normalized)) {
    candidates.unshift({
      label: "2026 FIRST regional rankings",
      url: "https://frc-events.firstinspires.org/ra/2026/teams",
    });
  }

  if (/\bminnesota|\bmn\b/.test(normalized)) {
    candidates.push(
      ...MINNESOTA_2026_EVENTS.map((event) => ({
        label: `${event.name} event page`,
        url: `${FIRST_BASE_URL}/${event.code}`,
      })),
    );
  }

  if (/\bauto|autonomous\b/.test(normalized)) {
    candidates.unshift({
      label: "Minnesota Granite City qualification matches",
      url: `${FIRST_BASE_URL}/MNMI2/qualifications`,
    });
  }

  return {
    candidates: dedupeByUrl(candidates),
  };
}

async function fetchAllowedUrl(url, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const parsed = new URL(url);

  if (!ALLOWED_RESEARCH_HOSTS.has(parsed.hostname)) {
    throw new Error(`Host not allowed for research: ${parsed.hostname}`);
  }

  onProgress({
    message: "Fetching source page.",
    source: url,
  });

  const html = await fetchText(url);
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();

  const title = normalizeText($("title").first().text()) || url;
  const text = normalizeText($("body").text()).slice(0, 12000);
  const links = $("a[href]")
    .map((_, anchor) => {
      const href = $(anchor).attr("href");
      const label = normalizeText($(anchor).text());

      try {
        const absolute = new URL(href, url).toString();
        return {
          label: label || absolute,
          url: absolute,
        };
      } catch {
        return null;
      }
    })
    .get()
    .filter(Boolean)
    .filter((link) => {
      try {
        return ALLOWED_RESEARCH_HOSTS.has(new URL(link.url).hostname);
      } catch {
        return false;
      }
    });

  return {
    url,
    title,
    text,
    links: dedupeByUrl(links).slice(0, 40),
  };
}

function dedupeByUrl(items) {
  const seen = new Set();
  const output = [];

  for (const item of items) {
    if (!item?.url || seen.has(item.url)) {
      continue;
    }
    seen.add(item.url);
    output.push(item);
  }

  return output;
}

function mergeSourceLists(...sourceLists) {
  return sanitizeSourceList(sourceLists.flat());
}

function getFirstRegionalApiAuthHeader() {
  return `Basic ${Buffer.from(
    `${FIRST_REGIONAL_API.username}:${FIRST_REGIONAL_API.apiKey}`,
  ).toString("base64")}`;
}

async function fetchFirstRegionalApiJson(pathname, options = {}) {
  const normalizedPath = String(pathname || "").replace(/^\/+/, "");
  const url = `${FIRST_REGIONAL_API.baseUrl}/${FIRST_REGIONAL_API.version}/${normalizedPath}`;
  return fetchJson(url, {
    headers: {
      Authorization: getFirstRegionalApiAuthHeader(),
      Accept: "application/json",
    },
    timeoutMs: options.timeoutMs,
  });
}

async function loadRegionalPointsRankingRows2026(options = {}) {
  const onProgress = options.onProgress || (() => {});
  const cacheKey = "regional-points-rankings-2026";
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    onProgress({
      message: "Using cached 2026 regional points rankings.",
      source: "https://frc-events.firstinspires.org/ra/2026/teams",
    });
    return cached.value;
  }

  onProgress({
    message: "Loading 2026 FIRST regional points rankings.",
    source: "https://frc-events.firstinspires.org/ra/2026/teams",
  });

  const firstPage = await fetchFirstRegionalApiJson(
    `${CURRENT_SEASON}/rankings/regional/teamdetail?page=1`,
  );
  const rankingRows = Array.isArray(firstPage.teams) ? [...firstPage.teams] : [];

  const pageTotal = Number(firstPage.pageTotal || 1);
  if (pageTotal > 1) {
    const remainingPages = Array.from({ length: pageTotal - 1 }, (_, index) => index + 2);
    const pageResults = await mapLimit(remainingPages, 6, async (pageNumber) => {
      onProgress({
        message: `Loading regional ranking page ${pageNumber} of ${pageTotal}.`,
        source: "https://frc-events.firstinspires.org/ra/2026/teams",
      });
      const page = await fetchFirstRegionalApiJson(
        `${CURRENT_SEASON}/rankings/regional/teamdetail?page=${pageNumber}`,
      );
      return Array.isArray(page.teams) ? page.teams : [];
    });
    rankingRows.push(...pageResults.flat());
  }

  cache.set(cacheKey, {
    fetchedAt: Date.now(),
    value: rankingRows,
  });

  return rankingRows;
}

async function getRegionalPointsRankings2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
  const minnesotaOnly = Boolean(input.minnesotaOnly);
  const rankingRows = await loadRegionalPointsRankingRows2026({ onProgress });
  const allTeamsDirectory = indexTeamsByNumber(await getAllTeamsDirectory2026({ onProgress }));

  let minnesotaDirectory = null;
  let filteredRows = rankingRows;

  if (minnesotaOnly) {
    minnesotaDirectory = await getMinnesotaTeamDirectory2026({ onProgress });
    filteredRows = rankingRows.filter((row) => minnesotaDirectory.has(String(row.teamNumber)));
  }

  const teams = filteredRows.slice(0, limit).map((row) => {
    const teamNumber = String(row.teamNumber);
    const teamDetail = minnesotaDirectory?.get(teamNumber) || allTeamsDirectory.get(teamNumber) || null;

    return {
      rank: row.rank,
      teamNumber,
      teamName: teamDetail?.name || row.nameShort || `Team ${teamNumber}`,
      location: teamDetail?.location || null,
      avatarUrl: teamDetail?.avatarUrl || DEFAULT_TEAM_AVATAR_URL,
      totalPoints: row.totalPoints,
      regional1Points: row.regional1Points,
      regional1EventCode: row.regional1Details?.tournamentCode || null,
      regional2Points: row.regional2Points,
      regional2Projection: row.regional2PointsProjection,
      regional2EventCode: row.regional2Details?.tournamentCode || null,
      championshipStatus: row.championshipStatus || null,
      firstChampionshipLabel: buildFirstChampionshipLabel(row),
      qualifiedFirstCmp: Boolean(row.qualifiedFirstCmp),
      qualifiedFirstCmpDate: row.qualifiedFirstCmpDate || null,
      firstTeamUrl:
        teamDetail?.firstTeamUrl || `https://frc-events.firstinspires.org/2026/team/${teamNumber}`,
      blueAllianceUrl: `https://www.thebluealliance.com/team/${teamNumber}`,
    };
  });

  return {
    type: "regional_rankings",
    season: CURRENT_SEASON,
    scope: minnesotaOnly ? "minnesota_teams" : "regional_pool",
    scopeLabel: minnesotaOnly
      ? "Minnesota teams in the 2026 regional pool"
      : "2026 FIRST regional pool",
    totalRankedTeams: filteredRows.length,
    returnedCount: teams.length,
    teams,
    sources: mergeSourceLists(
      [
        {
          label: "2026 FIRST regional team rankings",
          url: "https://frc-events.firstinspires.org/ra/2026/teams",
        },
      ],
      minnesotaOnly
        ? MINNESOTA_2026_EVENTS.map((event) => ({
            label: `${event.name} event page`,
            url: `${FIRST_BASE_URL}/${event.code}`,
          }))
        : [],
    ),
  };
}

async function loadStatboticsTeamYearsByEpa2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const stateCode = normalizeStateFilter(input.state);
  const cacheKey = `statbotics-team-years-2026-epa-${stateCode || "all"}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    onProgress({
      message: `Using cached 2026 Statbotics EPA rankings${stateCode ? ` for ${stateCode}` : ""}.`,
      source: "https://www.statbotics.io/teams",
    });
    return cached.value;
  }

  const pageSize = 100;
  const normalizedRows = [];

  for (let offset = 0; offset < 5000; offset += pageSize) {
    const params = new URLSearchParams({
      year: String(CURRENT_SEASON),
      metric: "epa",
      limit: String(pageSize),
      offset: String(offset),
    });
    if (stateCode) {
      params.set("country", "USA");
      params.set("state", stateCode);
    }

    const requestPath = `team_years?${params.toString()}`;
    onProgress({
      message:
        offset === 0
          ? `Loading ${CURRENT_SEASON} Statbotics EPA rankings${stateCode ? ` for ${stateCode}` : ""}.`
          : `Loading additional Statbotics EPA rows${stateCode ? ` for ${stateCode}` : ""} (offset ${offset}).`,
      source: `https://api.statbotics.io/v3/${requestPath}`,
    });

    const page = await fetchStatboticsJson(requestPath, {
      timeoutMs: options.timeoutMs || 60000,
    });
    const rows = Array.isArray(page) ? page : [];
    normalizedRows.push(...rows);

    if (rows.length < pageSize) {
      break;
    }
  }

  cache.set(cacheKey, {
    fetchedAt: Date.now(),
    value: normalizedRows,
  });
  return normalizedRows;
}

async function getEpaRankings2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
  const stateCode = normalizeStateFilter(input.state);
  const rankingRows = await loadStatboticsTeamYearsByEpa2026(
    {
      state: stateCode,
    },
    { onProgress },
  );
  const allTeamsDirectory = indexTeamsByNumber(await getAllTeamsDirectory2026({ onProgress }));

  const teams = rankingRows.slice(0, limit).map((row, index) => {
    const teamNumber = String(row.team);
    const teamDetail = allTeamsDirectory.get(teamNumber) || null;
    const epaBreakdown = row.epa?.breakdown || {};

    return {
      rank: index + 1,
      teamNumber,
      teamName: teamDetail?.name || `Team ${teamNumber}`,
      location: teamDetail?.location || [row.city, row.state, row.country].filter(Boolean).join(", ") || null,
      avatarUrl: teamDetail?.avatarUrl || DEFAULT_TEAM_AVATAR_URL,
      firstTeamUrl:
        teamDetail?.firstTeamUrl || `https://frc-events.firstinspires.org/${CURRENT_SEASON}/team/${teamNumber}`,
      blueAllianceUrl: teamDetail?.blueAllianceUrl || `https://www.thebluealliance.com/team/${teamNumber}`,
      epa: Number(epaBreakdown.total_points ?? row.epa?.total_points?.mean ?? 0),
      unitlessEpa: Number(row.epa?.unitless ?? 0),
      autoEpa: Number(epaBreakdown.auto_points ?? 0),
      teleopEpa: Number(epaBreakdown.teleop_points ?? 0),
      endgameEpa: Number(epaBreakdown.endgame_points ?? 0),
      overallRank: row.epa?.ranks?.total?.rank ?? null,
      stateRank: row.epa?.ranks?.state?.rank ?? null,
      stateCode: row.state || stateCode || null,
    };
  });

  return {
    type: "epa_rankings",
    season: CURRENT_SEASON,
    metric: "EPA",
    scope: stateCode ? "state_teams" : "all_teams",
    stateCode: stateCode || null,
    scopeLabel: stateCode ? buildStateScopeLabel(stateCode) : "All FRC teams",
    totalRankedTeams: rankingRows.length,
    returnedCount: teams.length,
    teams,
    sources: [
      {
        label: `${CURRENT_SEASON} Statbotics EPA rankings${stateCode ? ` (${stateCode})` : ""}`,
        url: "https://www.statbotics.io/teams",
      },
      {
        label: `${CURRENT_SEASON} FIRST all teams`,
        url: `${FIRST_BASE_URL}/allteams`,
      },
    ],
  };
}

async function loadEventTeamsByEventCode2026(eventCode, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const normalizedEventCode = String(eventCode || "").trim().toUpperCase();

  if (!normalizedEventCode) {
    throw new Error("Missing event code for team roster lookup.");
  }

  const cacheKey = `event-teams-${CURRENT_SEASON}-${normalizedEventCode}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    onProgress({
      message: `Using cached ${CURRENT_SEASON} team roster for ${normalizedEventCode}.`,
      source: `${FIRST_BASE_URL}/${normalizedEventCode}`,
    });
    return cached.value;
  }

  onProgress({
    message: `Loading ${CURRENT_SEASON} team roster for ${normalizedEventCode} from the FRC Events API.`,
    source: `${FIRST_REGIONAL_API.baseUrl}/${FIRST_REGIONAL_API.version}/${CURRENT_SEASON}/teams?eventCode=${normalizedEventCode}&page=1`,
  });

  const firstPage = await fetchFirstRegionalApiJson(
    `${CURRENT_SEASON}/teams?eventCode=${encodeURIComponent(normalizedEventCode)}&page=1`,
  );
  const teams = Array.isArray(firstPage.teams) ? [...firstPage.teams] : [];
  const pageTotal = Number(firstPage.pageTotal || 1);

  if (pageTotal > 1) {
    const remainingPages = Array.from({ length: pageTotal - 1 }, (_, index) => index + 2);
    const pageResults = await mapLimit(remainingPages, 4, async (pageNumber) => {
      onProgress({
        message: `Loading ${normalizedEventCode} roster page ${pageNumber} of ${pageTotal}.`,
        source: `${FIRST_REGIONAL_API.baseUrl}/${FIRST_REGIONAL_API.version}/${CURRENT_SEASON}/teams?eventCode=${normalizedEventCode}&page=${pageNumber}`,
      });
      const page = await fetchFirstRegionalApiJson(
        `${CURRENT_SEASON}/teams?eventCode=${encodeURIComponent(normalizedEventCode)}&page=${pageNumber}`,
      );
      return Array.isArray(page.teams) ? page.teams : [];
    });
    teams.push(...pageResults.flat());
  }

  const value = {
    teamCountTotal: Number(firstPage.teamCountTotal) || teams.length,
    teams,
  };
  cache.set(cacheKey, {
    fetchedAt: Date.now(),
    value,
  });
  return value;
}

async function loadEventRankingsByEventCode2026(eventCode, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const normalizedEventCode = String(eventCode || "").trim().toUpperCase();

  if (!normalizedEventCode) {
    throw new Error("Missing event code for rankings lookup.");
  }

  const cacheKey = `event-rankings-${CURRENT_SEASON}-${normalizedEventCode}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    onProgress({
      message: `Using cached ${CURRENT_SEASON} rankings for ${normalizedEventCode}.`,
      source: `${FIRST_BASE_URL}/${normalizedEventCode}/rankings`,
    });
    return cached.value;
  }

  onProgress({
    message: `Loading ${CURRENT_SEASON} rankings for ${normalizedEventCode} from the FRC Events API.`,
    source: `${FIRST_REGIONAL_API.baseUrl}/${FIRST_REGIONAL_API.version}/${CURRENT_SEASON}/rankings/${normalizedEventCode}`,
  });

  const payload = await fetchFirstRegionalApiJson(`${CURRENT_SEASON}/rankings/${normalizedEventCode}`);
  const rows = Array.isArray(payload?.Rankings) ? payload.Rankings : [];

  cache.set(cacheKey, {
    fetchedAt: Date.now(),
    value: rows,
  });
  return rows;
}

function extractChampionshipEventPageSummary(html, division) {
  const $ = cheerio.load(html);
  const eventName =
    normalizeText($("h1").first().text()) ||
    `FIRST Championship - FIRST Robotics Competition - ${division.name} Division`;
  const pageText = normalizeText($("body").text());
  const participantUpdatedAt =
    pageText.match(/Participant list last modified .*? event time\./i)?.[0] || null;
  const eventResultsCard = $(".card")
    .filter((_, card) =>
      normalizeText($(card).find(".card-header").first().text()).startsWith("Event Results"),
    )
    .first();
  const eventResultsMessage =
    normalizeText(eventResultsCard.find(".alert-info, .alert-warning").first().text()) || null;
  const eventResultsLinks = eventResultsCard
    .find('a.list-group-item[href]')
    .map((_, anchor) => {
      const href = $(anchor).attr("href");
      const label = normalizeText($(anchor).text());
      if (!href) {
        return null;
      }

      return {
        label: label || href,
        url: new URL(href, "https://frc-events.firstinspires.org").toString(),
      };
    })
    .get()
    .filter(Boolean);

  return {
    eventName,
    participantUpdatedAt,
    eventResultsMessage,
    eventResultsLinks: dedupeByUrl(eventResultsLinks),
  };
}

function extractStandingsStatusMessage(html) {
  const $ = cheerio.load(html);
  return (
    $(".alert-warning, .alert-info")
      .map((_, node) => normalizeText($(node).text()))
      .get()
      .find((text) =>
        /scheduled to begin|qualification matches|ranking data|return after the start/i.test(text),
      ) || null
  );
}

function buildChampionshipStandingsRowsFromApi(rows, teamDirectory) {
  return (rows || [])
    .map((row, index) => {
      const teamNumber = String(row.teamNumber || "").trim();
      if (!teamNumber) {
        return null;
      }

      const teamDetail = teamDirectory.get(teamNumber) || buildFallbackTeamDetail(teamNumber);
      return {
        rank: Number(row.rank) || index + 1,
        teamNumber,
        teamName: teamDetail.teamName || teamDetail.name || `Team ${teamNumber}`,
        location: teamDetail.location || null,
        avatarUrl: teamDetail.avatarUrl || DEFAULT_TEAM_AVATAR_URL,
        firstTeamUrl:
          teamDetail.firstTeamUrl || `https://frc-events.firstinspires.org/${CURRENT_SEASON}/team/${teamNumber}`,
        blueAllianceUrl: teamDetail.blueAllianceUrl || `https://www.thebluealliance.com/team/${teamNumber}`,
        rankingScore: Number(row.sortOrder1),
        matchScore: Number(row.sortOrder2),
        autoFuel: Number(row.sortOrder3),
        tower: Number(row.sortOrder4),
        record: [row.wins, row.losses, row.ties].every(Number.isFinite)
          ? `${row.wins} - ${row.losses} - ${row.ties}`
          : null,
        matchesPlayed: Number.isFinite(Number(row.matchesPlayed)) ? Number(row.matchesPlayed) : null,
      };
    })
    .filter(Boolean);
}

function extractChampionshipStandingsRowsFromHtml(html, teamDirectory) {
  const $ = cheerio.load(html);
  const rows = [];

  $("tbody tr").each((index, element) => {
    const cells = $(element).find("td");
    if (cells.length < 8) {
      return;
    }

    const teamLink = $(cells[1]).find('a[href*="/team/"]').first();
    const teamNumber = normalizeText(teamLink.text());
    if (!teamNumber) {
      return;
    }

    const teamDetail = teamDirectory.get(teamNumber) || buildFallbackTeamDetail(teamNumber);
    rows.push({
      rank: Number(parseScoreValue($(cells[0]).text())) || index + 1,
      teamNumber,
      teamName:
        teamDetail.teamName ||
        teamDetail.name ||
        normalizeText($(cells[1]).find(".d-none.d-md-block").first().text()) ||
        `Team ${teamNumber}`,
      location: teamDetail.location || null,
      avatarUrl:
        normalizeImageSource($(cells[1]).find("img").first().attr("src")) ||
        teamDetail.avatarUrl ||
        DEFAULT_TEAM_AVATAR_URL,
      firstTeamUrl:
        teamDetail.firstTeamUrl ||
        new URL(teamLink.attr("href") || `/2026/team/${teamNumber}`, "https://frc-events.firstinspires.org").toString(),
      blueAllianceUrl: teamDetail.blueAllianceUrl || `https://www.thebluealliance.com/team/${teamNumber}`,
      rankingScore: parseScoreValue($(cells[2]).text()),
      matchScore: parseScoreValue($(cells[3]).text()),
      autoFuel: parseScoreValue($(cells[4]).text()),
      tower: parseScoreValue($(cells[5]).text()),
      record: normalizeText($(cells[6]).text()) || null,
      matchesPlayed: Number(parseScoreValue($(cells[7]).text())) || null,
    });
  });

  return rows;
}

async function getChampionshipDivisionInfo2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const division = normalizeChampionshipDivision(
    input.divisionCode || input.divisionName || input.division,
  );

  if (!division) {
    return {
      supported: false,
      answer: "I could not identify that FIRST Championship division.",
      sources: [],
    };
  }

  const eventUrl = `${FIRST_BASE_URL}/${division.code}`;
  const [apiRoster, allTeams, eventHtml] = await Promise.all([
    loadEventTeamsByEventCode2026(division.code, { onProgress }),
    getAllTeamsDirectory2026({ onProgress }),
    fetchText(eventUrl),
  ]);
  const allTeamsDirectory = indexTeamsByNumber(allTeams);
  const pageDirectory = extractEventTeamDirectory(eventHtml);
  const pageSummary = extractChampionshipEventPageSummary(eventHtml, division);
  const apiTeamsByNumber = new Map(
    (apiRoster.teams || []).map((team) => [String(team.teamNumber), team]),
  );
  const orderedTeamNumbers = dedupeStrings([
    ...(apiRoster.teams || []).map((team) => String(team.teamNumber)),
    ...Array.from(pageDirectory.keys()),
  ]);

  const teams = orderedTeamNumbers.map((teamNumber) => {
    const apiTeam = apiTeamsByNumber.get(teamNumber) || null;
    const pageTeam = pageDirectory.get(teamNumber) || null;
    const knownTeam = allTeamsDirectory.get(teamNumber) || null;
    return {
      teamNumber,
      teamName:
        pageTeam?.name ||
        knownTeam?.name ||
        apiTeam?.nameShort ||
        apiTeam?.nameFull ||
        `Team ${teamNumber}`,
      location:
        pageTeam?.location ||
        knownTeam?.location ||
        [apiTeam?.city, apiTeam?.stateProv, apiTeam?.country].filter(Boolean).join(", ") ||
        null,
      avatarUrl: pageTeam?.avatarUrl || knownTeam?.avatarUrl || DEFAULT_TEAM_AVATAR_URL,
      firstTeamUrl:
        pageTeam?.firstTeamUrl ||
        knownTeam?.firstTeamUrl ||
        `https://frc-events.firstinspires.org/${CURRENT_SEASON}/team/${teamNumber}`,
      blueAllianceUrl:
        pageTeam?.blueAllianceUrl ||
        knownTeam?.blueAllianceUrl ||
        `https://www.thebluealliance.com/team/${teamNumber}`,
    };
  });

  return {
    supported: true,
    divisionCode: division.code,
    divisionName: division.name,
    eventName: pageSummary.eventName,
    eventUrl,
    rankingsUrl: `${eventUrl}/rankings`,
    teamCountTotal: Number(apiRoster.teamCountTotal) || teams.length,
    participantUpdatedAt: pageSummary.participantUpdatedAt,
    eventResultsMessage: pageSummary.eventResultsMessage,
    eventResultsLinks: pageSummary.eventResultsLinks,
    teams,
    sources: [
      {
        label: `${CURRENT_SEASON} ${division.name} division page`,
        url: eventUrl,
      },
      {
        label: `${CURRENT_SEASON} ${division.name} division roster API`,
        url: `${FIRST_REGIONAL_API.baseUrl}/${FIRST_REGIONAL_API.version}/${CURRENT_SEASON}/teams?eventCode=${division.code}`,
      },
    ],
  };
}

async function getChampionshipDivisionTeamsByEpa2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const divisionInfo = await getChampionshipDivisionInfo2026(
    {
      divisionCode: input.divisionCode,
    },
    { onProgress },
  );

  if (divisionInfo.supported === false) {
    return divisionInfo;
  }

  const limit = Math.max(1, Math.min(100, Number(input.limit) || divisionInfo.teams.length || 20));
  onProgress({
    message: `Loading ${CURRENT_SEASON} Statbotics EPA values for ${divisionInfo.teams.length} ${divisionInfo.divisionName} teams.`,
    source: "https://www.statbotics.io/teams",
  });

  const rankedTeams = (
    await mapLimit(divisionInfo.teams, 8, async (team) => {
      try {
        const statboticsTeamYear = await getStatboticsTeamYear(team.teamNumber, CURRENT_SEASON, {
          onProgress,
        });
        const epaBreakdown = statboticsTeamYear?.epa?.breakdown || {};
        return {
          ...team,
          epa: Number(epaBreakdown.total_points ?? statboticsTeamYear?.epa?.total_points?.mean ?? 0),
          unitlessEpa: Number(statboticsTeamYear?.epa?.unitless ?? 0),
          autoEpa: Number(epaBreakdown.auto_points ?? 0),
          teleopEpa: Number(epaBreakdown.teleop_points ?? 0),
          endgameEpa: Number(epaBreakdown.endgame_points ?? 0),
        };
      } catch {
        return {
          ...team,
          epa: Number.NaN,
          unitlessEpa: Number.NaN,
          autoEpa: Number.NaN,
          teleopEpa: Number.NaN,
          endgameEpa: Number.NaN,
        };
      }
    })
  )
    .filter((team) => Number.isFinite(team.epa))
    .sort((left, right) => right.epa - left.epa)
    .map((team, index) => ({
      rank: index + 1,
      ...team,
    }));

  return {
    type: "championship_division_epa_rankings",
    season: CURRENT_SEASON,
    metric: "EPA",
    scope: "championship_division",
    scopeLabel: `${divisionInfo.divisionName} Division teams`,
    divisionCode: divisionInfo.divisionCode,
    divisionName: divisionInfo.divisionName,
    eventName: divisionInfo.eventName,
    eventUrl: divisionInfo.eventUrl,
    rankingsUrl: divisionInfo.rankingsUrl,
    competingTeamCount: divisionInfo.teamCountTotal,
    participantUpdatedAt: divisionInfo.participantUpdatedAt,
    totalRankedTeams: rankedTeams.length,
    returnedCount: Math.min(limit, rankedTeams.length),
    teams: rankedTeams.slice(0, limit),
    sources: mergeSourceLists(divisionInfo.sources, [
      {
        label: `${CURRENT_SEASON} Statbotics EPA rankings`,
        url: "https://www.statbotics.io/teams",
      },
      {
        label: `${CURRENT_SEASON} ${divisionInfo.divisionName} division rankings page`,
        url: divisionInfo.rankingsUrl,
      },
    ]),
  };
}

async function getChampionshipDivisionStandings2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const divisionInfo = await getChampionshipDivisionInfo2026(
    {
      divisionCode: input.divisionCode,
    },
    { onProgress },
  );

  if (divisionInfo.supported === false) {
    return divisionInfo;
  }

  const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
  const teamDirectory = new Map(
    divisionInfo.teams.map((team) => [String(team.teamNumber), team]),
  );
  const [rankingRows, standingsHtml] = await Promise.all([
    loadEventRankingsByEventCode2026(divisionInfo.divisionCode, { onProgress }),
    fetchText(divisionInfo.rankingsUrl),
  ]);
  const standingsRowsFromApi = buildChampionshipStandingsRowsFromApi(rankingRows, teamDirectory);
  const standingsRows =
    standingsRowsFromApi.length > 0
      ? standingsRowsFromApi
      : extractChampionshipStandingsRowsFromHtml(standingsHtml, teamDirectory);
  const eventStatusMessage =
    extractStandingsStatusMessage(standingsHtml) ||
    divisionInfo.eventResultsMessage ||
    null;

  return {
    type: "championship_division_standings",
    season: CURRENT_SEASON,
    scope: "championship_division",
    scopeLabel: `${divisionInfo.divisionName} Division`,
    divisionCode: divisionInfo.divisionCode,
    divisionName: divisionInfo.divisionName,
    eventName: divisionInfo.eventName,
    eventUrl: divisionInfo.eventUrl,
    rankingsUrl: divisionInfo.rankingsUrl,
    competingTeamCount: divisionInfo.teamCountTotal,
    participantUpdatedAt: divisionInfo.participantUpdatedAt,
    eventStatusMessage,
    totalRankedTeams: standingsRows.length,
    returnedCount: Math.min(limit, standingsRows.length),
    teams: standingsRows.slice(0, limit),
    eventResultsLinks: divisionInfo.eventResultsLinks,
    sources: mergeSourceLists(divisionInfo.sources, [
      {
        label: `${CURRENT_SEASON} ${divisionInfo.divisionName} division rankings page`,
        url: divisionInfo.rankingsUrl,
      },
      {
        label: `${CURRENT_SEASON} ${divisionInfo.divisionName} division rankings API`,
        url: `${FIRST_REGIONAL_API.baseUrl}/${FIRST_REGIONAL_API.version}/${CURRENT_SEASON}/rankings/${divisionInfo.divisionCode}`,
      },
    ]),
  };
}

async function getAttachedTeamEpaRankings2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const attachmentContext = options.attachmentContext || null;
  const requestedQueries = attachmentContext?.teamQueries || [];
  const limit = Math.max(1, Math.min(ATTACHMENT_TEAM_FETCH_LIMIT, Number(input.limit) || requestedQueries.length || 20));

  if (requestedQueries.length === 0) {
    return {
      supported: false,
      answer: "No team entries could be extracted from the uploaded files. Use a text-based file with team numbers or team names.",
      sources: [],
    };
  }

  onProgress({
    message: `Extracted ${requestedQueries.length} team entries from the uploaded files.`,
    source: null,
  });

  const resolution = await resolveAttachmentTeamQueries2026(requestedQueries, { onProgress });
  if (resolution.teams.length === 0) {
    return {
      supported: false,
      answer: "I could not match any uploaded team entries to 2026 FIRST teams.",
      sources: [
        {
          label: "2026 FIRST all teams",
          url: `${FIRST_BASE_URL}/allteams`,
        },
      ],
    };
  }

  const rankedTeams = (
    await mapLimit(resolution.teams, 8, async (team) => {
      try {
        const statboticsTeamYear = await getStatboticsTeamYear(team.number, CURRENT_SEASON, { onProgress });
        const epaBreakdown = statboticsTeamYear?.epa?.breakdown || {};
        return {
          rank: 0,
          teamNumber: String(team.number),
          teamName: team.name,
          location: team.location,
          avatarUrl: team.avatarUrl || DEFAULT_TEAM_AVATAR_URL,
          firstTeamUrl: team.firstTeamUrl,
          blueAllianceUrl: team.blueAllianceUrl,
          originalQuery: team.originalQuery,
          epa: Number(epaBreakdown.total_points ?? statboticsTeamYear?.epa?.total_points?.mean ?? 0),
          unitlessEpa: Number(statboticsTeamYear?.epa?.unitless ?? 0),
          autoEpa: Number(epaBreakdown.auto_points ?? 0),
          teleopEpa: Number(epaBreakdown.teleop_points ?? 0),
          endgameEpa: Number(epaBreakdown.endgame_points ?? 0),
          overallRank: statboticsTeamYear?.epa?.ranks?.total?.rank ?? null,
          stateRank: statboticsTeamYear?.epa?.ranks?.state?.rank ?? null,
        };
      } catch (error) {
        onProgress({
          message: `Could not load Statbotics EPA for Team ${team.number}; skipping it.`,
          source: `https://www.statbotics.io/team/${team.number}`,
        });
        return null;
      }
    })
  )
    .filter(Boolean)
    .sort((left, right) => {
      if (right.epa !== left.epa) {
        return right.epa - left.epa;
      }

      return Number(left.teamNumber) - Number(right.teamNumber);
    })
    .map((team, index) => ({
      ...team,
      rank: index + 1,
    }));

  return {
    type: "attached_team_epa_rankings",
    season: CURRENT_SEASON,
    metric: "EPA",
    scope: "uploaded_team_list",
    scopeLabel: "Uploaded team list",
    inputTeamCount: requestedQueries.length,
    matchedTeamCount: rankedTeams.length,
    unresolvedQueries: resolution.unresolvedQueries,
    truncatedInput: resolution.truncatedInput,
    returnedCount: Math.min(limit, rankedTeams.length),
    totalRankedTeams: rankedTeams.length,
    teams: rankedTeams.slice(0, limit),
    attachments: summarizeAttachmentContext(attachmentContext),
    sources: [
      {
        label: `${CURRENT_SEASON} Statbotics teams`,
        url: "https://www.statbotics.io/teams",
      },
      {
        label: `${CURRENT_SEASON} FIRST all teams`,
        url: `${FIRST_BASE_URL}/allteams`,
      },
    ],
  };
}

async function resolveAttachmentTeamQueries2026(teamQueries, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const allTeams = await getAllTeamsDirectory2026({ onProgress });
  const matchedTeams = [];
  const unresolvedQueries = [];
  const seenTeamNumbers = new Set();

  for (const rawQuery of teamQueries.slice(0, ATTACHMENT_TEAM_FETCH_LIMIT)) {
    const query = cleanTeamQuery(rawQuery);
    if (!query) {
      continue;
    }

    let matchedTeam = null;
    const numericMatch = query.match(/^(?:team\s+)?(\d{1,5})$/i);

    if (numericMatch) {
      matchedTeam =
        allTeams.find((team) => String(team.number) === String(numericMatch[1])) ||
        buildFallbackTeamDetail(numericMatch[1]);
    } else {
      matchedTeam = findBestTeamMatches(query, allTeams)[0] || null;
    }

    if (!matchedTeam) {
      unresolvedQueries.push(rawQuery);
      continue;
    }

    if (seenTeamNumbers.has(String(matchedTeam.number))) {
      continue;
    }

    seenTeamNumbers.add(String(matchedTeam.number));
    matchedTeams.push({
      ...matchedTeam,
      originalQuery: rawQuery,
    });
  }

  return {
    teams: matchedTeams,
    unresolvedQueries: unresolvedQueries.slice(0, 12),
    truncatedInput: teamQueries.length > ATTACHMENT_TEAM_FETCH_LIMIT,
  };
}

async function fetchStatboticsJson(pathname, options = {}) {
  const normalizedPath = String(pathname || "").replace(/^\/+/, "");
  const url = `${STATBOTICS_API_BASE}/${normalizedPath}`;
  return fetchJson(url, {
    headers: {
      Accept: "application/json",
    },
    timeoutMs: options.timeoutMs,
  });
}

async function getStatboticsTeam(teamNumber, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const normalizedTeamNumber = String(teamNumber || "").trim();

  if (!normalizedTeamNumber) {
    throw new Error("Missing team number for Statbotics lookup.");
  }

  onProgress({
    message: `Looking up Team ${normalizedTeamNumber} in Statbotics.`,
    source: `https://www.statbotics.io/team/${normalizedTeamNumber}`,
  });

  return fetchStatboticsJson(`team/${normalizedTeamNumber}`, {
    timeoutMs: options.timeoutMs,
  });
}

async function getStatboticsTeamYear(teamNumber, year = CURRENT_SEASON, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const normalizedTeamNumber = String(teamNumber || "").trim();

  if (!normalizedTeamNumber) {
    throw new Error("Missing team number for Statbotics season lookup.");
  }

  const cacheKey = `statbotics-team-year-${year}-${normalizedTeamNumber}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    onProgress({
      message: `Using cached ${year} EPA data for Team ${normalizedTeamNumber}.`,
      source: `https://www.statbotics.io/team/${normalizedTeamNumber}`,
    });
    return cached.value;
  }

  onProgress({
    message: `Loading ${year} EPA data for Team ${normalizedTeamNumber} from Statbotics.`,
    source: `https://www.statbotics.io/team/${normalizedTeamNumber}`,
  });

  const result = await fetchStatboticsJson(`team_year/${normalizedTeamNumber}/${year}`, {
    timeoutMs: options.timeoutMs || 15000,
  });
  cache.set(cacheKey, {
    fetchedAt: Date.now(),
    value: result,
  });
  return result;
}

async function resolveTeamQuery2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const teamQuery = cleanTeamQuery(String(input.query || ""));
  const numericMatch = teamQuery.match(/^\d+$/) || teamQuery.match(/^team\s+(\d+)$/i);
  let resolvedTeam = null;

  if (numericMatch) {
    const teamNumber = numericMatch[1] || numericMatch[0];
    const teams = await getAllTeamsDirectory2026({ onProgress });
    resolvedTeam =
      teams.find((team) => String(team.number) === String(teamNumber)) || buildFallbackTeamDetail(teamNumber);
  } else {
    const teamLookup = await findTeamByName2026({ query: teamQuery }, { onProgress });
    if (teamLookup.supported === false) {
      return teamLookup;
    }

    resolvedTeam = {
      number: teamLookup.teamNumber,
      name: teamLookup.teamName,
      location: teamLookup.location,
      districtLabel: teamLookup.districtLabel,
      avatarUrl: teamLookup.avatarUrl,
      firstTeamUrl: teamLookup.firstTeamUrl,
      blueAllianceUrl: teamLookup.blueAllianceUrl,
    };
  }

  let statboticsTeam = null;
  try {
    statboticsTeam = await getStatboticsTeam(resolvedTeam.number, { onProgress });
  } catch (error) {
    onProgress({
      message: `Statbotics lookup failed for Team ${resolvedTeam.number}; continuing with official FIRST data.`,
      source: `https://www.statbotics.io/team/${resolvedTeam.number}`,
    });
  }
  const statboticsTeamRecord = statboticsTeam?.team || statboticsTeam || null;

  return {
    supported: true,
    query: teamQuery,
    teamNumber: String(resolvedTeam.number),
    teamName: statboticsTeamRecord?.name || resolvedTeam.name,
    location:
      resolvedTeam.location ||
      [statboticsTeamRecord?.state, statboticsTeamRecord?.country].filter(Boolean).join(", ") ||
      "Location unavailable",
    districtLabel: resolvedTeam.districtLabel || statboticsTeamRecord?.district || null,
    avatarUrl: resolvedTeam.avatarUrl || DEFAULT_TEAM_AVATAR_URL,
    firstTeamUrl: resolvedTeam.firstTeamUrl,
    blueAllianceUrl: resolvedTeam.blueAllianceUrl,
    statboticsUrl: `https://www.statbotics.io/team/${resolvedTeam.number}`,
    statboticsTeam: statboticsTeamRecord,
    sources: [
      {
        label: `${statboticsTeamRecord?.name || resolvedTeam.name} on Statbotics`,
        url: `https://www.statbotics.io/team/${resolvedTeam.number}`,
      },
      {
        label: `${resolvedTeam.name} official FIRST team page`,
        url: resolvedTeam.firstTeamUrl,
      },
      {
        label: "2026 FIRST all teams",
        url: `${FIRST_BASE_URL}/allteams`,
      },
    ],
  };
}

async function getTeamRegionalPoints2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const resolvedTeam = await resolveTeamQuery2026(
    {
      query: input.teamQuery,
    },
    { onProgress },
  );

  if (resolvedTeam.supported === false) {
    return resolvedTeam;
  }

  const rankingRows = await loadRegionalPointsRankingRows2026({ onProgress });
  const rankingRow = rankingRows.find(
    (row) => String(row.teamNumber) === String(resolvedTeam.teamNumber),
  );

  if (!rankingRow) {
    return {
      supported: false,
      answer: `${resolvedTeam.teamName} (Team ${resolvedTeam.teamNumber}) does not appear in the 2026 official FIRST regional-points rankings yet.`,
      sources: mergeSourceLists(resolvedTeam.sources, [
        {
          label: "2026 FIRST regional team rankings",
          url: "https://frc-events.firstinspires.org/ra/2026/teams",
        },
      ]),
    };
  }

  return {
    type: "team_regional_points",
    season: CURRENT_SEASON,
    query: resolvedTeam.query,
    teamNumber: resolvedTeam.teamNumber,
    teamName: resolvedTeam.teamName,
    location: resolvedTeam.location,
    districtLabel: resolvedTeam.districtLabel,
    avatarUrl: resolvedTeam.avatarUrl || DEFAULT_TEAM_AVATAR_URL,
    firstTeamUrl: resolvedTeam.firstTeamUrl,
    blueAllianceUrl: resolvedTeam.blueAllianceUrl,
    statboticsUrl: resolvedTeam.statboticsUrl,
    totalPoints: rankingRow.totalPoints,
    rank: rankingRow.rank,
    championshipStatus: rankingRow.championshipStatus || null,
    firstChampionshipLabel: buildFirstChampionshipLabel(rankingRow),
    qualifiedFirstCmp: Boolean(rankingRow.qualifiedFirstCmp),
    qualifiedFirstCmpDate: rankingRow.qualifiedFirstCmpDate || null,
    qualifiedFirstCmpEventCode: rankingRow.qualifiedFirstCmpEventCode || null,
    qualifiedFirstCmpEventWeek: rankingRow.qualifiedFirstCmpEventWeek || null,
    regional1Points: rankingRow.regional1Points,
    regional1EventCode: rankingRow.regional1Details?.tournamentCode || null,
    regional2Points: rankingRow.regional2Points,
    regional2Projection: rankingRow.regional2PointsProjection,
    regional2EventCode: rankingRow.regional2Details?.tournamentCode || null,
    sources: mergeSourceLists(resolvedTeam.sources, [
      {
        label: "2026 FIRST regional team rankings",
        url: "https://frc-events.firstinspires.org/ra/2026/teams",
      },
    ]),
  };
}

async function getRegionalEventPoints2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const eventCode = normalizeText(String(input.eventCode || "")).toUpperCase();
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));

  if (!eventCode) {
    throw new Error("Missing event code for regional event rankings.");
  }

  const allTeamsDirectory = indexTeamsByNumber(await getAllTeamsDirectory2026({ onProgress }));

  onProgress({
    message: `Loading regional points for ${eventCode}.`,
    source: `https://frc-events.firstinspires.org/ra/2026/regional/${eventCode}`,
  });

  const firstPage = await fetchFirstRegionalApiJson(
    `${CURRENT_SEASON}/rankings/regional/eventdetail/${eventCode}?page=1`,
  );
  let teamDetails = Array.isArray(firstPage.teamDetails) ? [...firstPage.teamDetails] : [];
  const pageTotal = Number(firstPage.pageTotal || 1);

  if (pageTotal > 1) {
    const remainingPages = Array.from({ length: pageTotal - 1 }, (_, index) => index + 2);
    const pageResults = await mapLimit(remainingPages, 6, async (pageNumber) => {
      onProgress({
        message: `Loading ${eventCode} regional-points page ${pageNumber} of ${pageTotal}.`,
        source: `https://frc-events.firstinspires.org/ra/2026/regional/${eventCode}`,
      });
      const page = await fetchFirstRegionalApiJson(
        `${CURRENT_SEASON}/rankings/regional/eventdetail/${eventCode}?page=${pageNumber}`,
      );
      return Array.isArray(page.teamDetails) ? page.teamDetails : [];
    });
    teamDetails.push(...pageResults.flat());
  }

  const teams = teamDetails.slice(0, limit).map((row) => {
    const teamNumber = String(row.teamNumber);
    const teamDetail = allTeamsDirectory.get(teamNumber) || null;
    return {
      rank: row.rank,
      teamNumber,
      teamName: teamDetail?.name || row.teamName || `Team ${teamNumber}`,
      location: teamDetail?.location || null,
      avatarUrl: teamDetail?.avatarUrl || DEFAULT_TEAM_AVATAR_URL,
      regionalPoints: row.regionalPoints,
      championshipStatus: row.championshipStatus || null,
      firstChampionshipLabel: buildFirstChampionshipLabel(row),
      firstTeamUrl:
        teamDetail?.firstTeamUrl || `https://frc-events.firstinspires.org/2026/team/${teamNumber}`,
      blueAllianceUrl: `https://www.thebluealliance.com/team/${teamNumber}`,
    };
  });

  return {
    type: "regional_event_rankings",
    season: CURRENT_SEASON,
    eventCode,
    eventName: firstPage.eventName || eventCode,
    eventStatus: firstPage.eventStatus || null,
    totalRankedTeams: teamDetails.length,
    returnedCount: teams.length,
    teams,
    sources: [
      {
        label: `${firstPage.eventName || eventCode} event page`,
        url: `${FIRST_BASE_URL}/${eventCode}`,
      },
      {
        label: `${firstPage.eventName || eventCode} regional rankings`,
        url: `https://frc-events.firstinspires.org/ra/2026/regional/${eventCode}`,
      },
    ],
  };
}

function extractEventPageSummary(html, fallbackName = "") {
  const $ = cheerio.load(html);
  const eventName =
    normalizeText($("h1").first().text())
      .replace(/^2026 Event Information -\s*/i, "")
      .replace(/^2026 Rankings -\s*/i, "") ||
    normalizeText($("title").first().text()).split(" FRC Event Web")[0] ||
    fallbackName;
  const eventStatusMessage =
    $(".alert-warning, .alert-info")
      .map((_, node) => normalizeText($(node).text()))
      .get()
      .find(
        (text) =>
          text &&
          !/small screen/i.test(text) &&
          !/heads up/i.test(text) &&
          (/in progress/i.test(text) || /not yet started/i.test(text) || /results will/i.test(text)),
      ) || null;

  return {
    eventName,
    eventStatusMessage,
  };
}

function extractTeamEventMatchRows(html, targetTeamNumber, stage) {
  const $ = cheerio.load(html);
  const rows = [];
  const normalizedTarget = String(targetTeamNumber);
  const noMatchesMessage =
    $(".alert-info, .alert-warning")
      .map((_, node) => normalizeText($(node).text()))
      .get()
      .find((text) => /did not participate|no matches yet|there were not any/i.test(text)) || null;

  $("#matches tbody tr").each((index, rowNode) => {
    const cells = $(rowNode).find("td");
    if (cells.length < 8) {
      return;
    }

    const matchLink = $(cells[0]).find("a").first();
    const matchLabel = normalizeText($(cells[0]).text());
    const startTimeLabel = normalizeText($(cells[1]).text()) || null;
    const redTeamNumbers = [2, 3, 4]
      .map((cellIndex) => normalizeText($(cells[cellIndex]).find("a").first().text()))
      .filter(Boolean);
    const blueTeamNumbers = [5, 6, 7]
      .map((cellIndex) => normalizeText($(cells[cellIndex]).find("a").first().text()))
      .filter(Boolean);
    const redScore =
      cells.length > 8 && normalizeText($(cells[8]).text())
        ? parseScoreValue($(cells[8]).text())
        : Number.NaN;
    const blueScore =
      cells.length > 9 && normalizeText($(cells[9]).text())
        ? parseScoreValue($(cells[9]).text())
        : Number.NaN;
    const allianceColor = redTeamNumbers.includes(normalizedTarget)
      ? "red"
      : blueTeamNumbers.includes(normalizedTarget)
        ? "blue"
        : null;

    if (!allianceColor) {
      return;
    }

    const partnerTeamNumbers =
      allianceColor === "red"
        ? redTeamNumbers.filter((teamNumber) => teamNumber !== normalizedTarget)
        : blueTeamNumbers.filter((teamNumber) => teamNumber !== normalizedTarget);
    const opponentTeamNumbers = allianceColor === "red" ? blueTeamNumbers : redTeamNumbers;
    const matchHref = matchLink.attr("href");

    rows.push({
      id: `${stage}-${index + 1}`,
      stage,
      matchLabel,
      startTimeLabel,
      redTeamNumbers,
      blueTeamNumbers,
      allianceColor,
      partnerTeamNumbers,
      opponentTeamNumbers,
      redScore: Number.isFinite(redScore) ? redScore : null,
      blueScore: Number.isFinite(blueScore) ? blueScore : null,
      targetTeamScore:
        allianceColor === "red"
          ? Number.isFinite(redScore)
            ? redScore
            : null
          : Number.isFinite(blueScore)
            ? blueScore
            : null,
      opponentScore:
        allianceColor === "red"
          ? Number.isFinite(blueScore)
            ? blueScore
            : null
          : Number.isFinite(redScore)
            ? redScore
            : null,
      matchUrl: matchHref
        ? `https://frc-events.firstinspires.org${matchHref}`
        : null,
    });
  });

  return {
    rows,
    noMatchesMessage,
  };
}

function buildTeamSeasonEpaDetail(teamNumber, teamDetail, statboticsTeamYear) {
  const epaBreakdown = statboticsTeamYear?.epa?.breakdown || {};
  return {
    teamNumber: String(teamNumber),
    teamName: teamDetail?.name || `Team ${teamNumber}`,
    location: teamDetail?.location || "Location unavailable",
    avatarUrl: teamDetail?.avatarUrl || DEFAULT_TEAM_AVATAR_URL,
    firstTeamUrl:
      teamDetail?.firstTeamUrl || `https://frc-events.firstinspires.org/${CURRENT_SEASON}/team/${teamNumber}`,
    blueAllianceUrl: teamDetail?.blueAllianceUrl || `https://www.thebluealliance.com/team/${teamNumber}`,
    epa: Number(epaBreakdown.total_points ?? statboticsTeamYear?.epa?.total_points?.mean ?? Number.NaN),
    autoEpa: Number(epaBreakdown.auto_points ?? Number.NaN),
    teleopEpa: Number(epaBreakdown.teleop_points ?? Number.NaN),
    endgameEpa: Number(epaBreakdown.endgame_points ?? Number.NaN),
  };
}

async function getTeamEventMatchupEpa2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const eventCode = normalizeText(String(input.eventCode || "")).toUpperCase();

  if (!eventCode) {
    throw new Error("Missing event code for team matchup EPA lookup.");
  }

  const resolvedTeam = await resolveTeamQuery2026(
    {
      query: input.teamQuery,
    },
    { onProgress },
  );
  if (resolvedTeam.supported === false) {
    return resolvedTeam;
  }

  onProgress({
    message: `Loading ${eventCode} event details for Team ${resolvedTeam.teamNumber}.`,
    source: `${FIRST_BASE_URL}/${eventCode}`,
  });

  const [eventHtml, qualificationHtml, playoffHtml, allTeams] = await Promise.all([
    fetchText(`${FIRST_BASE_URL}/${eventCode}`),
    fetchText(`${FIRST_BASE_URL}/${eventCode}/qualifications?team=${resolvedTeam.teamNumber}`),
    fetchText(`${FIRST_BASE_URL}/${eventCode}/playoffs?team=${resolvedTeam.teamNumber}`),
    getAllTeamsDirectory2026({ onProgress }),
  ]);

  const eventSummary = extractEventPageSummary(eventHtml, eventCode);
  const qualificationRows = extractTeamEventMatchRows(
    qualificationHtml,
    resolvedTeam.teamNumber,
    "qualification",
  );
  const playoffRows = extractTeamEventMatchRows(playoffHtml, resolvedTeam.teamNumber, "playoff");
  const rawMatches = [...qualificationRows.rows, ...playoffRows.rows];
  const allTeamsDirectory = indexTeamsByNumber(allTeams);

  const relatedTeamNumbers = dedupeStrings(
    rawMatches.flatMap((match) => [...match.partnerTeamNumbers, ...match.opponentTeamNumbers]),
  );
  const relatedTeamDetails = new Map();

  await mapLimit(relatedTeamNumbers, 8, async (teamNumber) => {
    const knownTeam = allTeamsDirectory.get(String(teamNumber)) || buildFallbackTeamDetail(teamNumber);
    let statboticsTeamYear = null;
    try {
      statboticsTeamYear = await getStatboticsTeamYear(teamNumber, CURRENT_SEASON, { onProgress });
    } catch {
      statboticsTeamYear = null;
    }

    relatedTeamDetails.set(
      String(teamNumber),
      buildTeamSeasonEpaDetail(teamNumber, knownTeam, statboticsTeamYear),
    );
  });

  let targetTeamSeason = null;
  try {
    targetTeamSeason = await getStatboticsTeamYear(resolvedTeam.teamNumber, CURRENT_SEASON, { onProgress });
  } catch {
    targetTeamSeason = null;
  }

  const targetTeamDetail = buildTeamSeasonEpaDetail(
    resolvedTeam.teamNumber,
    {
      name: resolvedTeam.teamName,
      location: resolvedTeam.location,
      avatarUrl: resolvedTeam.avatarUrl,
      firstTeamUrl: resolvedTeam.firstTeamUrl,
      blueAllianceUrl: resolvedTeam.blueAllianceUrl,
    },
    targetTeamSeason,
  );

  const matches = rawMatches.map((match) => ({
    ...match,
    partnerTeams: match.partnerTeamNumbers.map(
      (teamNumber) => relatedTeamDetails.get(String(teamNumber)) || buildFallbackTeamDetail(teamNumber),
    ),
    opponentTeams: match.opponentTeamNumbers.map(
      (teamNumber) => relatedTeamDetails.get(String(teamNumber)) || buildFallbackTeamDetail(teamNumber),
    ),
  }));

  return {
    type: "team_event_matchup_epa",
    season: CURRENT_SEASON,
    eventCode,
    eventName: eventSummary.eventName || eventCode,
    eventStatusMessage: eventSummary.eventStatusMessage,
    teamNumber: resolvedTeam.teamNumber,
    teamName: resolvedTeam.teamName,
    team: targetTeamDetail,
    qualificationMatchCount: qualificationRows.rows.length,
    playoffMatchCount: playoffRows.rows.length,
    totalMatchCount: matches.length,
    matches,
    sources: mergeSourceLists(resolvedTeam.sources, [
      {
        label: `${eventSummary.eventName || eventCode} event page`,
        url: `${FIRST_BASE_URL}/${eventCode}`,
      },
      {
        label: `${eventSummary.eventName || eventCode} team-filtered qualifications`,
        url: `${FIRST_BASE_URL}/${eventCode}/qualifications?team=${resolvedTeam.teamNumber}`,
      },
      {
        label: `${eventSummary.eventName || eventCode} team-filtered playoffs`,
        url: `${FIRST_BASE_URL}/${eventCode}/playoffs?team=${resolvedTeam.teamNumber}`,
      },
      {
        label: `${CURRENT_SEASON} Statbotics EPA rankings`,
        url: "https://www.statbotics.io/teams",
      },
    ]),
    answer:
      matches.length === 0
        ? `${resolvedTeam.teamName} (Team ${resolvedTeam.teamNumber}) do not have any published matches yet for ${eventSummary.eventName || eventCode}.`
        : null,
  };
}

async function getEventRankingsWithEpa2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const eventCode = normalizeText(String(input.eventCode || "")).toUpperCase();

  if (!eventCode) {
    throw new Error("Missing event code for event rankings with EPA lookup.");
  }

  onProgress({
    message: `Loading ${eventCode} event rankings.`,
    source: `${FIRST_BASE_URL}/${eventCode}/rankings`,
  });

  const [rankingRows, eventHtml, allTeams] = await Promise.all([
    loadEventRankingsByEventCode2026(eventCode, { onProgress }),
    fetchText(`${FIRST_BASE_URL}/${eventCode}/rankings`),
    getAllTeamsDirectory2026({ onProgress }),
  ]);

  const allTeamsDirectory = indexTeamsByNumber(allTeams);
  const eventSummary = extractEventPageSummary(eventHtml, eventCode);

  const teams = (
    await mapLimit(rankingRows, 8, async (row, index) => {
      const teamNumber = String(row.teamNumber || "").trim();
      if (!teamNumber) {
        return null;
      }

      const knownTeam = allTeamsDirectory.get(teamNumber) || buildFallbackTeamDetail(teamNumber);
      let statboticsTeamYear = null;
      try {
        statboticsTeamYear = await getStatboticsTeamYear(teamNumber, CURRENT_SEASON, { onProgress });
      } catch {
        statboticsTeamYear = null;
      }

      const seasonEpa = buildTeamSeasonEpaDetail(teamNumber, knownTeam, statboticsTeamYear);
      return {
        rank: Number(row.rank) || index + 1,
        teamNumber,
        teamName: seasonEpa.teamName,
        location: seasonEpa.location,
        avatarUrl: seasonEpa.avatarUrl,
        firstTeamUrl: seasonEpa.firstTeamUrl,
        blueAllianceUrl: seasonEpa.blueAllianceUrl,
        rankingScore: Number(row.sortOrder1),
        matchScore: Number(row.sortOrder2),
        autoFuel: Number(row.sortOrder3),
        tower: Number(row.sortOrder4),
        record: [row.wins, row.losses, row.ties].every(Number.isFinite)
          ? `${row.wins} - ${row.losses} - ${row.ties}`
          : null,
        matchesPlayed: Number.isFinite(Number(row.matchesPlayed)) ? Number(row.matchesPlayed) : null,
        epa: seasonEpa.epa,
        autoEpa: seasonEpa.autoEpa,
        teleopEpa: seasonEpa.teleopEpa,
        endgameEpa: seasonEpa.endgameEpa,
      };
    })
  ).filter(Boolean);

  return {
    type: "event_rankings_with_epa",
    season: CURRENT_SEASON,
    eventCode,
    eventName: eventSummary.eventName || eventCode,
    eventStatusMessage: eventSummary.eventStatusMessage,
    totalRankedTeams: teams.length,
    returnedCount: teams.length,
    teams,
    sources: [
      {
        label: `${eventSummary.eventName || eventCode} rankings`,
        url: `${FIRST_BASE_URL}/${eventCode}/rankings`,
      },
      {
        label: `${eventSummary.eventName || eventCode} rankings API`,
        url: `${FIRST_REGIONAL_API.baseUrl}/${FIRST_REGIONAL_API.version}/${CURRENT_SEASON}/rankings/${eventCode}`,
      },
      {
        label: `${CURRENT_SEASON} Statbotics EPA rankings`,
        url: "https://www.statbotics.io/teams",
      },
    ],
  };
}

async function getMinnesotaTeamDirectory2026(options = {}) {
  const onProgress = options.onProgress || (() => {});
  const cacheKey = "minnesota-team-directory-2026";
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const mergedDirectory = new Map();

  for (const event of MINNESOTA_2026_EVENTS) {
    onProgress({
      message: `Loading Minnesota team directory from ${event.name}.`,
      source: `${FIRST_BASE_URL}/${event.code}`,
    });

    const eventDirectory = await getEventTeamDirectory(event.code);
    for (const [teamNumber, teamDetail] of eventDirectory.entries()) {
      if (isMinnesotaLocation(teamDetail.location)) {
        mergedDirectory.set(teamNumber, teamDetail);
      }
    }
  }

  cache.set(cacheKey, {
    fetchedAt: Date.now(),
    value: mergedDirectory,
  });

  return mergedDirectory;
}

async function getAllTeamsDirectory2026(options = {}) {
  const onProgress = options.onProgress || (() => {});
  const cacheKey = "all-teams-directory-2026";
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    onProgress({
      message: "Using cached 2026 FIRST team directory.",
      source: `${FIRST_BASE_URL}/allteams`,
    });
    return cached.value;
  }

  const storedSnapshot = await readTeamDirectorySnapshot();
  if (storedSnapshot && isFreshTimestamp(storedSnapshot.fetchedAt, TEAM_DIRECTORY_FILE_TTL_MS)) {
    onProgress({
      message: "Using the local 2026 team icon database.",
      source: `${FIRST_BASE_URL}/allteams`,
    });
    cache.set(cacheKey, {
      fetchedAt: Date.now(),
      value: storedSnapshot.teams,
    });
    return storedSnapshot.teams;
  }

  onProgress({
    message: "Loading the official 2026 FIRST team directory and team avatars.",
    source: `${FIRST_BASE_URL}/allteams`,
  });

  let teams = null;

  try {
    const html = await fetchText(`${FIRST_BASE_URL}/allteams`);
    teams = extractAllTeamsDirectory(html);
    void writeTeamDirectorySnapshot(teams).catch((error) => {
      console.warn(
        `Failed to refresh the local team icon database: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  } catch (error) {
    if (!storedSnapshot) {
      throw error;
    }

    onProgress({
      message: "Falling back to the saved local team icon database.",
      source: `${FIRST_BASE_URL}/allteams`,
    });
    teams = storedSnapshot.teams;
  }

  cache.set(cacheKey, {
    fetchedAt: Date.now(),
    value: teams,
  });

  return teams;
}

async function findTeamByName2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const query = normalizeText(String(input.query || ""));
  const normalizedQuery = normalizeTeamNameForSearch(query);

  if (!normalizedQuery) {
    return {
      supported: false,
      answer: "I could not determine the team name to look up.",
      sources: [
        {
          label: "2026 FIRST all teams",
          url: `${FIRST_BASE_URL}/allteams`,
        },
      ],
    };
  }

  const teams = await getAllTeamsDirectory2026({ onProgress });
  const matches = findBestTeamMatches(query, teams);

  if (matches.length === 0) {
    return {
      supported: false,
      answer: `I could not find a 2026 FIRST team matching "${query}" on the official FIRST all-teams list.`,
      sources: [
        {
          label: "2026 FIRST all teams",
          url: `${FIRST_BASE_URL}/allteams`,
        },
      ],
    };
  }

  const bestMatch = matches[0];
  onProgress({
    message: `Matched "${query}" to Team ${bestMatch.number} ${bestMatch.name}.`,
    source: bestMatch.firstTeamUrl,
  });

  return {
    type: "team_lookup",
    season: CURRENT_SEASON,
    query,
    teamNumber: bestMatch.number,
    teamName: bestMatch.name,
    location: bestMatch.location,
    districtLabel: bestMatch.districtLabel,
    avatarUrl: bestMatch.avatarUrl || DEFAULT_TEAM_AVATAR_URL,
    firstTeamUrl: bestMatch.firstTeamUrl,
    blueAllianceUrl: bestMatch.blueAllianceUrl,
    matches: matches.slice(0, 5).map((team) => ({
      teamNumber: team.number,
      teamName: team.name,
      location: team.location,
      avatarUrl: team.avatarUrl || DEFAULT_TEAM_AVATAR_URL,
      blueAllianceUrl: team.blueAllianceUrl,
      firstTeamUrl: team.firstTeamUrl,
    })),
    sources: [
      {
        label: `${bestMatch.name} official FIRST team page`,
        url: bestMatch.firstTeamUrl,
      },
      {
        label: "2026 FIRST all teams",
        url: `${FIRST_BASE_URL}/allteams`,
      },
    ],
  };
}

function isMinnesotaLocation(location) {
  return /\bminnesota\b|\bmn\b/i.test(String(location || ""));
}

async function getMinnesotaAutoMax2026(options = {}) {
  const matchSummaries = await getMinnesotaMatchSummaries2026(options);
  const scoredMatches = matchSummaries.filter((summary) => Number.isFinite(summary.maxAutoPoints));

  if (scoredMatches.length === 0) {
    throw new Error("No Minnesota 2026 autonomous score rows were available from FIRST.");
  }

  scoredMatches.sort((left, right) => {
    if (right.maxAutoPoints !== left.maxAutoPoints) {
      return right.maxAutoPoints - left.maxAutoPoints;
    }

    return left.matchUrl.localeCompare(right.matchUrl);
  });

  const best = scoredMatches[0];
  return {
    type: "highest_auto_score",
    season: CURRENT_SEASON,
    region: "Minnesota",
    eventCount: MINNESOTA_2026_EVENTS.length,
    scannedMatchCount: matchSummaries.length,
    highestAutoScore: best.maxAutoPoints,
    highestScore: best.maxAutoPoints,
    displayLabel: "Highest auto score",
    metricLabel: "Autonomous Points",
    allianceColor: best.maxAllianceColor,
    allianceTeams: best.maxAllianceTeams,
    allianceTeamDetails: best.maxAllianceTeamDetails,
    eventName: best.eventName,
    eventCode: best.eventCode,
    matchName: best.matchName,
    matchUrl: best.matchUrl,
    eventUrl: `${FIRST_BASE_URL}/${best.eventCode}`,
    sources: [
      {
        label: `${best.eventName} - ${best.matchName}`,
        url: best.matchUrl,
      },
      {
        label: `${best.eventName} event page`,
        url: `${FIRST_BASE_URL}/${best.eventCode}`,
      },
      {
        label: "2026 FIRST event list",
        url: `${FIRST_BASE_URL}/Events/EventList`,
      },
    ],
    leaderboard: scoredMatches.slice(0, 5).map((summary) => ({
      eventName: summary.eventName,
      matchName: summary.matchName,
      matchUrl: summary.matchUrl,
      highestAutoScore: summary.maxAutoPoints,
      highestScore: summary.maxAutoPoints,
      allianceColor: summary.maxAllianceColor,
      allianceTeams: summary.maxAllianceTeams,
      allianceTeamDetails: summary.maxAllianceTeamDetails,
    })),
  };
}

async function getMinnesotaMatchSummaries2026(options = {}) {
  const onProgress = options.onProgress || (() => {});
  const cacheKey = "minnesota-match-summaries-2026";
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    onProgress({
      message: "Using cached Minnesota 2026 match summaries.",
      source: `${FIRST_BASE_URL}/Events/EventList`,
    });
    return cached.value;
  }

  const allTeamsDirectory = indexTeamsByNumber(await getAllTeamsDirectory2026({ onProgress }));
  const matchSummaries = [];

  for (const event of MINNESOTA_2026_EVENTS) {
    onProgress({
      message: `Loading event roster for ${event.name}.`,
      source: `${FIRST_BASE_URL}/${event.code}`,
    });
    const teamDirectory = await getEventTeamDirectory(event.code);

    onProgress({
      message: `Loading qualification match list for ${event.name}.`,
      source: `${FIRST_BASE_URL}/${event.code}/qualifications`,
    });
    const qualificationLinks = await getMatchLinks(event.code, "qualifications");

    onProgress({
      message: `Loading playoff match list for ${event.name}.`,
      source: `${FIRST_BASE_URL}/${event.code}/playoffs`,
    });
    const playoffLinks = await getMatchLinks(event.code, "playoffs");

    onProgress({
      message: `Scanning ${qualificationLinks.length + playoffLinks.length} match pages for ${event.name}.`,
      source: `${FIRST_BASE_URL}/${event.code}`,
    });

    const eventRows = await mapLimit(
      [...qualificationLinks, ...playoffLinks],
      MATCH_FETCH_CONCURRENCY,
      async (matchPath, index) =>
        getMatchSummary(event, matchPath, {
          teamDirectory,
          fallbackTeamDirectory: allTeamsDirectory,
          onProgress,
          matchIndex: index + 1,
          matchCount: qualificationLinks.length + playoffLinks.length,
        }),
    );

    matchSummaries.push(...eventRows.filter(Boolean));

    onProgress({
      message: `Finished ${event.name}.`,
      source: `${FIRST_BASE_URL}/${event.code}`,
    });
  }

  if (matchSummaries.length === 0) {
    throw new Error("No Minnesota 2026 match summaries were available from FIRST.");
  }

  cache.set(cacheKey, {
    fetchedAt: Date.now(),
    value: matchSummaries,
  });

  return matchSummaries;
}

async function getMinnesotaScoreCategoryMax2026(input = {}, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const metricQuery = extractMetricQuery(input.metricQuery);
  const rawMetricQuery = normalizeText(String(input.metricQuery || ""));
  const matchSummaries = await getMinnesotaMatchSummaries2026({ onProgress });
  const availableLabels = Array.from(
    new Set(matchSummaries.flatMap((summary) => summary.scoreBreakdown.map((row) => row.label))),
  ).sort((left, right) => left.localeCompare(right));

  if (!metricQuery) {
    return {
      supported: false,
      answer:
        "I could not determine which scoring category to inspect. Try a more specific term such as tower, autonomous, teleop, or foul.",
      sources: [
        {
          label: "2026 FIRST event list",
          url: `${FIRST_BASE_URL}/Events/EventList`,
        },
      ],
    };
  }

  const matchingLabels = findMatchingScoreLabels(metricQuery, availableLabels);
  const preferredLabels = matchingLabels.some((label) => /\bpoints?\b/i.test(label))
    ? matchingLabels.filter((label) => /\bpoints?\b/i.test(label))
    : matchingLabels;
  onProgress({
    message:
      preferredLabels.length > 0
        ? `Matched "${rawMetricQuery || metricQuery}" to score rows: ${preferredLabels.join(", ")}.`
        : `No official score rows matched "${rawMetricQuery || metricQuery}".`,
    source: `${FIRST_BASE_URL}/Events/EventList`,
  });

  if (preferredLabels.length === 0) {
    return {
      supported: false,
      answer: [
        `I could not find an official Minnesota 2026 score row matching "${rawMetricQuery || metricQuery}".`,
        `Available score rows on FIRST match pages include: ${availableLabels.join(", ")}.`,
      ].join(" "),
      sources: [
        {
          label: "2026 FIRST event list",
          url: `${FIRST_BASE_URL}/Events/EventList`,
        },
      ],
    };
  }

  const matchingLabelSet = new Set(preferredLabels);
  const leaderboard = [];

  for (const summary of matchSummaries) {
    for (const row of summary.scoreBreakdown) {
      if (!matchingLabelSet.has(row.label)) {
        continue;
      }

      const blueScore = Number.isFinite(row.blueScore) ? row.blueScore : -Infinity;
      const redScore = Number.isFinite(row.redScore) ? row.redScore : -Infinity;
      const highestScore = Math.max(blueScore, redScore);

      if (!Number.isFinite(highestScore)) {
        continue;
      }

      const allianceColor = blueScore >= redScore ? "blue" : "red";
      leaderboard.push({
        eventName: summary.eventName,
        eventCode: summary.eventCode,
        matchName: summary.matchName,
        matchUrl: summary.matchUrl,
        metricLabel: row.label,
        highestScore,
        allianceColor,
        allianceTeams: allianceColor === "blue" ? summary.blueTeams : summary.redTeams,
        allianceTeamDetails:
          allianceColor === "blue" ? summary.blueTeamDetails : summary.redTeamDetails,
      });
    }
  }

  leaderboard.sort((left, right) => {
    if (right.highestScore !== left.highestScore) {
      return right.highestScore - left.highestScore;
    }

    if (left.metricLabel !== right.metricLabel) {
      return left.metricLabel.localeCompare(right.metricLabel);
    }

    return left.matchUrl.localeCompare(right.matchUrl);
  });

  const best = leaderboard[0];
  if (!best) {
    return {
      supported: false,
      answer: `I found matching score rows for "${rawMetricQuery || metricQuery}", but no numeric scores were available on the official Minnesota 2026 match pages.`,
      sources: [
        {
          label: "2026 FIRST event list",
          url: `${FIRST_BASE_URL}/Events/EventList`,
        },
      ],
    };
  }

  return {
    type: "highest_score_category",
    season: CURRENT_SEASON,
    region: "Minnesota",
    eventCount: MINNESOTA_2026_EVENTS.length,
    scannedMatchCount: matchSummaries.length,
    metricQuery: rawMetricQuery || metricQuery,
    metricLabel: best.metricLabel,
    matchedLabels: preferredLabels,
    displayLabel:
      preferredLabels.length === 1
        ? `Highest ${best.metricLabel.toLowerCase()}`
        : `Highest ${metricQuery} score`,
    highestScore: best.highestScore,
    allianceColor: best.allianceColor,
    allianceTeams: best.allianceTeams,
    allianceTeamDetails: best.allianceTeamDetails,
    eventName: best.eventName,
    eventCode: best.eventCode,
    matchName: best.matchName,
    matchUrl: best.matchUrl,
    eventUrl: `${FIRST_BASE_URL}/${best.eventCode}`,
    sources: [
      {
        label: `${best.eventName} - ${best.matchName}`,
        url: best.matchUrl,
      },
      {
        label: `${best.eventName} event page`,
        url: `${FIRST_BASE_URL}/${best.eventCode}`,
      },
      {
        label: "2026 FIRST event list",
        url: `${FIRST_BASE_URL}/Events/EventList`,
      },
    ],
    leaderboard: leaderboard.slice(0, 5),
  };
}

async function getMatchLinks(eventCode, stage) {
  const html = await fetchText(`${FIRST_BASE_URL}/${eventCode}/${stage}`);
  const pattern = new RegExp(`/2026/${eventCode}/${stage}/[^"?#]+`, "g");
  return [...new Set([...html.matchAll(pattern)].map((match) => match[0]))];
}

async function getEventTeamDirectory(eventCode) {
  const html = await fetchText(`${FIRST_BASE_URL}/${eventCode}`);
  return extractEventTeamDirectory(html);
}

function extractEventTeamDirectory(html) {
  const $ = cheerio.load(html);
  const directory = new Map();

  $('a.list-group-item[href^="/2026/team/"]').each((_, anchor) => {
    const row = $(anchor);
    const teamNumber = normalizeText(row.find(".fw-bold").first().text());

    if (!teamNumber) {
      return;
    }

    const teamName = normalizeText(row.find(".col-6").first().text());
    const location = normalizeText(row.find(".d-none.d-md-block span").first().text());
    const firstTeamPath = row.attr("href");
    const avatarUrl = normalizeImageSource(row.find("img").first().attr("src"));

    directory.set(teamNumber, {
      number: teamNumber,
      name: teamName || `Team ${teamNumber}`,
      location: location || "Location unavailable",
      avatarUrl: avatarUrl || DEFAULT_TEAM_AVATAR_URL,
      firstTeamUrl: firstTeamPath
        ? `https://frc-events.firstinspires.org${firstTeamPath}`
        : `https://frc-events.firstinspires.org/2026/team/${teamNumber}`,
      blueAllianceUrl: `https://www.thebluealliance.com/team/${teamNumber}`,
    });
  });

  return directory;
}

function extractAllTeamsDirectory(html) {
  const $ = cheerio.load(html);
  const teams = [];

  $('a.list-group-item[href^="/2026/team/"]').each((_, anchor) => {
    const row = $(anchor);
    const teamNumber = normalizeText(row.find(".fw-bold").first().text());
    const teamName = normalizeText(row.find(".col-6.col-md-4").first().text());
    const metaColumns = row.find(".d-none.d-md-block");
    const districtLabel = normalizeText($(metaColumns[0]).text());
    const location = normalizeText($(metaColumns[1]).text());
    const firstTeamPath = row.attr("href");
    const avatarUrl = normalizeImageSource(row.find("img").first().attr("src"));

    if (!teamNumber || !teamName) {
      return;
    }

    teams.push({
      number: teamNumber,
      name: teamName,
      districtLabel: districtLabel || "Unknown",
      location: location || "Location unavailable",
      avatarUrl: avatarUrl || DEFAULT_TEAM_AVATAR_URL,
      firstTeamUrl: firstTeamPath
        ? `https://frc-events.firstinspires.org${firstTeamPath}`
        : `https://frc-events.firstinspires.org/2026/team/${teamNumber}`,
      blueAllianceUrl: `https://www.thebluealliance.com/team/${teamNumber}`,
    });
  });

  return teams;
}

function normalizeImageSource(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

async function readTeamDirectorySnapshot() {
  try {
    const raw = await fs.readFile(TEAM_DIRECTORY_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");

    if (!Array.isArray(parsed?.teams)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

async function writeTeamDirectorySnapshot(teams) {
  await fs.mkdir(path.dirname(TEAM_DIRECTORY_FILE), { recursive: true });
  await fs.writeFile(
    TEAM_DIRECTORY_FILE,
    `${JSON.stringify({
      season: CURRENT_SEASON,
      fetchedAt: new Date().toISOString(),
      teamCount: teams.length,
      teams,
    })}\n`,
    "utf8",
  );
}

function isFreshTimestamp(value, ttlMs) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && Date.now() - time < ttlMs;
}

function indexTeamsByNumber(teams) {
  return new Map((teams || []).map((team) => [String(team.number), team]));
}

function getKnownTeamDetail(teamNumber, ...directories) {
  for (const directory of directories) {
    const teamDetail = directory?.get(String(teamNumber));
    if (teamDetail) {
      return teamDetail;
    }
  }

  return buildFallbackTeamDetail(teamNumber);
}

function buildFirstChampionshipLabel(row) {
  if (row?.qualifiedFirstCmp && row?.qualifiedFirstCmpEventCode) {
    return `Direct Qualified at ${row.qualifiedFirstCmpEventCode}`;
  }

  if (row?.qualifiedFirstCmp) {
    return "Qualified for FIRST Championship";
  }

  if (row?.championshipStatus === "QualifiedFromRegionalPool") {
    return row?.qualifiedFirstCmpEventWeek
      ? `Regional Pool Week ${row.qualifiedFirstCmpEventWeek}`
      : "Qualified from the regional pool";
  }

  if (row?.championshipStatus === "Prequalified") {
    return "Prequalified";
  }

  return "Not yet qualified";
}

async function ensureHistoryStore() {
  await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });

  try {
    await fs.access(HISTORY_FILE);
  } catch {
    await fs.writeFile(HISTORY_FILE, "[]\n", "utf8");
  }
}

async function readHistory() {
  await ensureHistoryStore();
  const raw = await fs.readFile(HISTORY_FILE, "utf8");
  const parsed = JSON.parse(raw || "[]");
  return Array.isArray(parsed) ? parsed : [];
}

function queueHistoryWrite(updateHistory) {
  historyWriteQueue = historyWriteQueue.then(async () => {
    const history = await readHistory();
    const nextHistory = await updateHistory(history);
    await fs.writeFile(HISTORY_FILE, `${JSON.stringify(nextHistory, null, 2)}\n`, "utf8");
  });

  return historyWriteQueue;
}

function pruneHistoryKeepOldest(history) {
  if (!Array.isArray(history) || history.length <= 1) {
    return Array.isArray(history) ? history : [];
  }

  const sorted = [...history].sort(
    (left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
  const oldestEntry = sorted[0];
  return oldestEntry ? [oldestEntry] : [];
}

async function getMatchSummary(event, matchPath, options = {}) {
  try {
    const onProgress = options.onProgress || (() => {});
    const teamDirectory = options.teamDirectory || new Map();
    const fallbackTeamDirectory = options.fallbackTeamDirectory || new Map();
    const matchUrl = `https://frc-events.firstinspires.org${matchPath}`;

    onProgress({
      message: `Fetching match ${options.matchIndex || "?"}/${options.matchCount || "?"} for ${event.name}.`,
      source: matchUrl,
    });

    const html = await fetchText(matchUrl);
    const $ = cheerio.load(html);
    const scoreBreakdown = extractScoreBreakdown(html);
    const autoRow = scoreBreakdown.find((row) => row.label === "Autonomous Points");

    if (!autoRow) {
      return null;
    }

    const blueAutoPoints = autoRow.blueScore;
    const redAutoPoints = autoRow.redScore;

    const teamsRow = $("tr")
      .filter((_, row) => normalizeText($(row).find("td").first().text()) === "Teams")
      .first();

    const teamCells = teamsRow.find("td");
    const blueTeams = $(teamCells[1])
      .find(".col-sm-4")
      .map((_, node) => normalizeText($(node).text()))
      .get()
      .filter(Boolean);
    const redTeams = $(teamCells[2])
      .find(".col-sm-4")
      .map((_, node) => normalizeText($(node).text()))
      .get()
      .filter(Boolean);
    const blueTeamDetails = blueTeams.map((teamNumber) =>
      getKnownTeamDetail(teamNumber, teamDirectory, fallbackTeamDirectory),
    );
    const redTeamDetails = redTeams.map((teamNumber) =>
      getKnownTeamDetail(teamNumber, teamDirectory, fallbackTeamDirectory),
    );

    const titleText = normalizeText($("title").text());
    const titleMatch = titleText.match(/^(.*?)\s+FRC Event Web\s+:\s+(.*?)$/);
    const eventName = titleMatch ? titleMatch[1] : event.name;
    const matchName = titleMatch ? titleMatch[2] : matchPath.split("/").pop();
    const maxAllianceColor = blueAutoPoints >= redAutoPoints ? "blue" : "red";
    const maxAllianceTeams = blueAutoPoints >= redAutoPoints ? blueTeams : redTeams;
    const maxAllianceTeamDetails = blueAutoPoints >= redAutoPoints ? blueTeamDetails : redTeamDetails;

    return {
      eventCode: event.code,
      eventName,
      matchName,
      matchUrl,
      blueTeams,
      redTeams,
      blueTeamDetails,
      redTeamDetails,
      scoreBreakdown,
      blueAutoPoints,
      redAutoPoints,
      maxAutoPoints: Math.max(blueAutoPoints, redAutoPoints),
      maxAllianceColor,
      maxAllianceTeams,
      maxAllianceTeamDetails,
    };
  } catch (error) {
    console.warn(`Skipping ${matchPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "FIRST query MVP",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`${response.status} fetching ${url}`);
  }

  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "FIRST query MVP",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs || 15000),
  });

  if (!response.ok) {
    throw new Error(`${response.status} fetching ${url}`);
  }

  return response.json();
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  return results;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeSearchText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeTeamNameForSearch(value) {
  return normalizeSearchText(value);
}

function extractTeamLookupName(question) {
  const normalized = normalizeText(question);
  const patterns = [
    /\bteam number for\s+(.+?)\??$/i,
    /\bwhat team number is\s+(.+?)\??$/i,
    /\bwhich team is\s+(.+?)\??$/i,
    /\bwho are\s+(.+?)\??$/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return normalizeText(match[1]).replace(/^the\s+/i, "");
    }
  }

  return "";
}

function cleanTeamQuery(value) {
  let cleaned = normalizeText(value).replace(/^the\s+/i, "").trim();

  if (/^team\s+\d+$/i.test(cleaned)) {
    return cleaned.replace(/^team\s+/i, "").trim();
  }

  cleaned = cleaned.replace(/\s+team$/i, "").trim();
  return cleaned;
}

function extractRegionalPointsTeamQuery(question) {
  const normalized = normalizeText(question);

  if (!/\bregional points?\b/i.test(normalized)) {
    return "";
  }

  const patterns = [
    /\bhow many regional points? does\s+(.+?)\s+have\??$/i,
    /\bregional points? does\s+(.+?)\s+have\??$/i,
    /\bwhat are the regional points? for\s+(.+?)\??$/i,
    /\bregional points? for\s+(.+?)\??$/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return cleanTeamQuery(match[1]);
    }
  }

  return "";
}

function extractFirstChampionshipTeamQuery(question) {
  const normalized = normalizeText(question);

  if (!/\b(world'?s?|first championship|championship|champs?)\b/i.test(normalized)) {
    return "";
  }

  const patterns = [
    /\bis\s+(.+?)\s+going to\s+world'?s?\??$/i,
    /\bis\s+(.+?)\s+going to\s+the\s+first championship\??$/i,
    /\bdid\s+(.+?)\s+qualify for\s+world'?s?\??$/i,
    /\bdid\s+(.+?)\s+qualify for\s+the\s+first championship\??$/i,
    /\bis\s+(.+?)\s+qualified for\s+world'?s?\??$/i,
    /\bis\s+(.+?)\s+qualified for\s+the\s+first championship\??$/i,
    /\bhas\s+(.+?)\s+qualified for\s+world'?s?\??$/i,
    /\bhas\s+(.+?)\s+qualified for\s+the\s+first championship\??$/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return cleanTeamQuery(match[1]);
    }
  }

  return "";
}

function extractMetricQuery(value) {
  return normalizeSearchText(value)
    .split(" ")
    .filter(Boolean)
    .filter((token) => !SCORE_QUERY_STOP_WORDS.has(token))
    .join(" ");
}

function extractRequestedLimit(value, defaultLimit = 20, maxLimit = 100) {
  const normalized = String(value || "").toLowerCase();
  const match =
    normalized.match(/\btop\s+(\d+)\b/) ||
    normalized.match(/\bfirst\s+(\d+)\b/) ||
    normalized.match(/\bbest\s+(\d+)\b/) ||
    normalized.match(/\bleading\s+(\d+)\b/);
  const limit = match ? Number(match[1]) : defaultLimit;
  return Math.max(1, Math.min(maxLimit, limit));
}

function normalizeStateFilter(value) {
  const normalized = normalizeSearchText(value);
  if (!normalized) {
    return null;
  }

  if (/^[a-z]{2}$/.test(normalized)) {
    return normalized.toUpperCase();
  }

  return US_STATE_ALIASES.get(normalized) || null;
}

function buildStateScopeLabel(stateCode) {
  if (stateCode === "MN") {
    return "Minnesota teams";
  }

  for (const [name, code] of US_STATE_ALIASES.entries()) {
    if (code === stateCode && name.length > 2) {
      return `${name.replace(/\b\w/g, (letter) => letter.toUpperCase())} teams`;
    }
  }

  return `${stateCode} teams`;
}

function normalizeSpecialEventAlias(question) {
  const normalized = normalizeSearchText(question);
  if (!normalized) {
    return null;
  }

  if (
    normalized.includes("mnst") ||
    normalized.includes("minnesota state high school league championship") ||
    normalized.includes("minnesota state championship")
  ) {
    return SPECIAL_EVENT_ALIASES.find((event) => event.code === "MNST") || null;
  }

  return null;
}

function extractTeamQueryFromMatchupQuestion(question) {
  const normalized = normalizeText(question);
  const patterns = [
    /\bpartners?(?:\s+and|\/)?\s*opponents?\s+of\s+(.+?)\s+in\b/i,
    /\bepa of all\s+(.+?)'?s\s+partners?\s+and\s+opponents?\b/i,
    /\bshow\s+(.+?)'?s\s+partners?\s+and\s+opponents?\b/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      return cleanTeamQuery(match[1]).replace(/^epa of\s+/i, "").trim();
    }
  }

  const numberedMatch =
    normalized.match(/\bteam\s+(\d{1,5})\b/i) ||
    normalized.match(/\bof\s+(\d{1,5})(?:'s)?\b/i) ||
    normalized.match(/\b(\d{1,5})'s\b/);
  if (numberedMatch) {
    return numberedMatch[1];
  }

  const numericCandidates = normalized.match(/\b\d{1,5}\b/g) || [];
  const filteredCandidates = numericCandidates.filter((value) => value !== String(CURRENT_SEASON));
  return filteredCandidates[0] || "";
}

function extractTeamEventMatchupEpaRequest(question) {
  const normalized = String(question || "").toLowerCase();
  const event = normalizeSpecialEventAlias(question);
  const mentionsEpa = /\bepa\b/.test(normalized);
  const mentionsMatchups =
    /\bpartners?\b/.test(normalized) ||
    /\bopponents?\b/.test(normalized);
  const asksForMatchByMatch = /\bmatch by match\b/.test(normalized);

  if (!event || !mentionsMatchups || (!mentionsEpa && !asksForMatchByMatch)) {
    return null;
  }

  const teamQuery = extractTeamQueryFromMatchupQuestion(question);
  if (!teamQuery) {
    return null;
  }

  return {
    teamQuery,
    eventCode: event.code,
    eventName: event.name,
  };
}

function extractEventRankingsWithEpaRequest(question) {
  const normalized = String(question || "").toLowerCase();
  const event = normalizeSpecialEventAlias(question);
  const mentionsRankings = /\brankings?\b|\bcurrent rank\b|\bcurrent standings\b/.test(normalized);
  const mentionsEpa = /\bepa\b/.test(normalized);
  const asksForTable = /\btable\b|\bshow\b|\blist\b|\binclude\b/.test(normalized);

  if (!event || !mentionsRankings || !mentionsEpa || !asksForTable) {
    return null;
  }

  return {
    eventCode: event.code,
    eventName: event.name,
  };
}

function normalizeChampionshipDivision(value) {
  const normalized = normalizeSearchText(value);
  if (!normalized) {
    return null;
  }

  for (const division of CHAMPIONSHIP_DIVISIONS) {
    if (
      normalized === normalizeSearchText(division.name) ||
      normalized === normalizeSearchText(division.code)
    ) {
      return division;
    }
  }

  return null;
}

function findChampionshipDivisionInQuestion(question) {
  const normalized = normalizeSearchText(question);
  if (!normalized) {
    return null;
  }

  for (const division of CHAMPIONSHIP_DIVISIONS) {
    const divisionName = normalizeSearchText(division.name);
    const divisionCode = normalizeSearchText(division.code);
    if (
      normalized.includes(` ${divisionName} division `) ||
      normalized.startsWith(`${divisionName} division `) ||
      normalized.endsWith(` ${divisionName} division`) ||
      normalized === `${divisionName} division` ||
      normalized.split(" ").includes(divisionName) ||
      normalized.split(" ").includes(divisionCode)
    ) {
      return division;
    }
  }

  return null;
}

function extractChampionshipDivisionEpaRequest(question) {
  const normalized = String(question || "").toLowerCase();
  const division = findChampionshipDivisionInQuestion(question);
  const asksForRanking =
    /\b(top|best|highest|ranked|ranking|sorted|sort|leading)\b/.test(normalized) ||
    /\bwhich teams\b/.test(normalized);

  if (!division || !/\bepa\b/.test(normalized) || !asksForRanking) {
    return null;
  }

  const wantsAllTeams = /\ball (?:the )?teams?\b|\bentire division\b|\bwhole division\b/.test(normalized);
  return {
    divisionCode: division.code,
    divisionName: division.name,
    limit: extractRequestedLimit(question, wantsAllTeams ? 75 : 20, 100),
  };
}

function extractChampionshipDivisionStandingsRequest(question) {
  const normalized = String(question || "").toLowerCase();
  const division = findChampionshipDivisionInQuestion(question);
  const asksStandings =
    /\bstanding|standings|snapshot\b/.test(normalized) ||
    /\bqualification rankings?\b/.test(normalized) ||
    /\branking score\b/.test(normalized);

  if (!division || /\bepa\b/.test(normalized) || !asksStandings) {
    return null;
  }

  return {
    divisionCode: division.code,
    divisionName: division.name,
    limit: extractRequestedLimit(question, 20, 100),
  };
}

function extractEpaRankingRequest(question) {
  const normalized = String(question || "").toLowerCase();
  const mentionsEpa = /\bepa\b/.test(normalized);
  const asksForRanking =
    /\b(top|best|highest|ranked|ranking|sorted|sort|leading)\b/.test(normalized) ||
    /\bwhich teams\b/.test(normalized);

  if (!mentionsEpa || !asksForRanking) {
    return null;
  }

  const stateCode =
    /\bminnesota\b|\bmn\b/.test(normalized)
      ? "MN"
      : normalizeStateFilter(
          Array.from(US_STATE_ALIASES.keys()).find((name) => normalized.includes(name)) || "",
        );

  return {
    limit: extractRequestedLimit(question),
    state: stateCode,
  };
}

function findMatchingScoreLabels(metricQuery, scoreLabels) {
  const normalizedMetric = normalizeSearchText(metricQuery);
  if (!normalizedMetric) {
    return [];
  }

  const metricTokens = normalizedMetric
    .split(" ")
    .filter(Boolean)
    .filter((token) => token !== "score" && token !== "scores" && token !== "point" && token !== "points");

  return scoreLabels.filter((label) => {
    const normalizedLabel = normalizeSearchText(label);

    if (!normalizedLabel) {
      return false;
    }

    if (normalizedLabel.includes(normalizedMetric) || normalizedMetric.includes(normalizedLabel)) {
      return true;
    }

    const labelTokens = new Set(normalizedLabel.split(" ").filter(Boolean));
    return metricTokens.length > 0 && metricTokens.every((token) => labelTokens.has(token));
  });
}

function parseScoreValue(value) {
  const match = normalizeText(value).match(/[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

function extractScoreBreakdown(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("tr").each((_, row) => {
    const cells = $(row).find("td");
    if (cells.length < 3) {
      return;
    }

    const label = normalizeText($(cells[0]).text());
    if (!label) {
      return;
    }

    const blueScore = parseScoreValue($(cells[1]).text());
    const redScore = parseScoreValue($(cells[2]).text());
    if (!Number.isFinite(blueScore) && !Number.isFinite(redScore)) {
      return;
    }

    rows.push({
      label,
      blueScore: Number.isFinite(blueScore) ? blueScore : null,
      redScore: Number.isFinite(redScore) ? redScore : null,
    });
  });

  return rows;
}

function scoreTeamNameMatch(query, team) {
  const normalizedQuery = normalizeTeamNameForSearch(query);
  const normalizedName = normalizeTeamNameForSearch(team.name);

  if (!normalizedQuery || !normalizedName) {
    return -Infinity;
  }

  if (normalizedQuery === normalizedName) {
    return 1000;
  }

  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  const nameTokens = normalizedName.split(" ").filter(Boolean);
  const nameTokenSet = new Set(nameTokens);
  const overlapCount = queryTokens.filter((token) => nameTokenSet.has(token)).length;

  let score = overlapCount * 20;

  if (normalizedName.includes(normalizedQuery)) {
    score += 120;
  }

  if (normalizedQuery.includes(normalizedName)) {
    score += 80;
  }

  if (queryTokens.length > 0 && overlapCount === queryTokens.length) {
    score += 140;
  }

  if (queryTokens.length === nameTokens.length && overlapCount === queryTokens.length) {
    score += 200;
  }

  if (team.number === normalizedQuery) {
    score += 900;
  }

  return score;
}

function findBestTeamMatches(query, teams) {
  return teams
    .map((team) => ({
      ...team,
      matchScore: scoreTeamNameMatch(query, team),
    }))
    .filter((team) => team.matchScore >= 60)
    .sort((left, right) => {
      if (right.matchScore !== left.matchScore) {
        return right.matchScore - left.matchScore;
      }

      return Number(left.number) - Number(right.number);
    });
}

function buildFallbackTeamDetail(teamNumber) {
  return {
    number: teamNumber,
    name: `Team ${teamNumber}`,
    location: "Location unavailable",
    avatarUrl: DEFAULT_TEAM_AVATAR_URL,
    firstTeamUrl: `https://frc-events.firstinspires.org/2026/team/${teamNumber}`,
    blueAllianceUrl: `https://www.thebluealliance.com/team/${teamNumber}`,
  };
}

function summarizeHistoryEntry(entry) {
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    question: entry.question,
    attachments: entry.attachments || [],
    answer: entry.answer,
    supported: entry.supported,
    intent: entry.intent || null,
    highestAutoScore: entry.result?.highestAutoScore ?? null,
    eventName: entry.result?.eventName ?? null,
    matchName: entry.result?.matchName ?? null,
  };
}

function buildAnswerText(result) {
  return [
    `Highest autonomous score found: ${result.highestAutoScore} points.`,
    `Match: ${result.matchName} at the ${result.eventName}.`,
    `Alliance: ${capitalize(result.allianceColor)} alliance (${result.allianceTeams.join(", ")}).`,
    `Coverage: ${result.scannedMatchCount} official FIRST match pages across ${result.eventCount} Minnesota events.`,
  ].join(" ");
}

function buildScoreCategoryAnswer(result) {
  const matchedLabelNote =
    Array.isArray(result.matchedLabels) && result.matchedLabels.length > 1
      ? `Matched score rows: ${result.matchedLabels.join(", ")}. `
      : "";

  return [
    `Highest ${result.metricQuery} score found: ${result.highestScore} points.`,
    `Specific score row: ${result.metricLabel}.`,
    `Match: ${result.matchName} at the ${result.eventName}.`,
    `Alliance: ${capitalize(result.allianceColor)} alliance (${result.allianceTeams.join(", ")}).`,
    matchedLabelNote,
    `Coverage: ${result.scannedMatchCount} official FIRST match pages across ${result.eventCount} Minnesota events.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildTeamLookupAnswer(result) {
  return [
    `${result.teamName} is FRC Team ${result.teamNumber}.`,
    result.location ? `Location: ${result.location}.` : "",
    `Verified on the official FIRST ${result.season} all-teams list.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildTeamRegionalPointsAnswer(result) {
  const secondEventText =
    result.regional2Points == null && result.regional2Projection != null
      ? `Second event projection: ${result.regional2Projection} points${result.regional2EventCode ? ` (${result.regional2EventCode})` : ""}.`
      : result.regional2Points != null
        ? `Second regional: ${result.regional2Points} points${result.regional2EventCode ? ` (${result.regional2EventCode})` : ""}.`
        : "";
  const firstChampionshipText = result.firstChampionshipLabel
    ? `FIRST Championship: ${result.firstChampionshipLabel}.`
    : "";

  return [
    `${result.teamName} (Team ${result.teamNumber}) have ${result.totalPoints} regional points in the 2026 FIRST regional pool as of ${new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "long", day: "numeric" })}.`,
    `Current rank: #${result.rank}.`,
    result.regional1Points != null
      ? `First regional: ${result.regional1Points} points${result.regional1EventCode ? ` (${result.regional1EventCode})` : ""}.`
      : "",
    secondEventText,
    firstChampionshipText,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildTeamChampionshipAnswer(result) {
  const statusText = result.firstChampionshipLabel || "Not yet qualified";

  return [
    result.qualifiedFirstCmp
      ? `${result.teamName} (Team ${result.teamNumber}) are invited to the 2026 FIRST Championship.`
      : `${result.teamName} (Team ${result.teamNumber}) are not yet invited to the 2026 FIRST Championship.`,
    `Status: ${statusText}.`,
    `Regional points: ${result.totalPoints}.`,
    result.rank ? `Regional pool rank: #${result.rank}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildRegionalRankingsAnswer(result) {
  const preview = result.teams
    .slice(0, Math.min(5, result.teams.length))
    .map((team) => `#${team.rank} ${team.teamNumber} ${team.teamName} (${team.totalPoints} pts)`)
    .join("; ");

  return [
    `${result.scopeLabel} ranked by regional points for ${result.season}.`,
    preview ? `Top teams: ${preview}.` : "",
    `Returned ${result.returnedCount} teams from a field of ${result.totalRankedTeams}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildRegionalEventAnswer(result) {
  const preview = result.teams
    .slice(0, Math.min(5, result.teams.length))
    .map((team) => `#${team.rank} ${team.teamNumber} ${team.teamName} (${team.regionalPoints} pts)`)
    .join("; ");

  return [
    `${result.eventName} regional points standings for ${result.season}.`,
    result.eventStatus ? `Event status: ${result.eventStatus}.` : "",
    preview ? `Top teams: ${preview}.` : "",
    `Returned ${result.returnedCount} teams from a field of ${result.totalRankedTeams}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildEpaRankingsAnswer(result) {
  const preview = result.teams
    .slice(0, Math.min(5, result.teams.length))
    .map((team) => `#${team.rank} ${team.teamNumber} ${team.teamName} (EPA ${team.epa.toFixed(1)})`)
    .join("; ");

  return [
    `${result.scopeLabel} ranked by ${result.metric} for ${result.season}.`,
    preview ? `Top teams: ${preview}.` : "",
    `Returned ${result.returnedCount} teams from a field of ${result.totalRankedTeams}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildChampionshipDivisionEpaAnswer(result) {
  const preview = result.teams
    .slice(0, Math.min(5, result.teams.length))
    .map((team) => `#${team.rank} ${team.teamNumber} ${team.teamName} (EPA ${team.epa.toFixed(1)})`)
    .join("; ");

  return [
    `${result.scopeLabel} ranked by EPA for ${result.season}.`,
    result.participantUpdatedAt ? `${result.participantUpdatedAt}` : "",
    preview ? `Top teams: ${preview}.` : "",
    `Returned ${result.returnedCount} teams from a field of ${result.competingTeamCount}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildChampionshipDivisionStandingsAnswer(result) {
  if (!Array.isArray(result.teams) || result.teams.length === 0) {
    return [
      `${result.scopeLabel} standings for ${result.season} are not posted yet.`,
      result.eventStatusMessage || "",
      `Competing teams currently listed: ${result.competingTeamCount}.`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  const preview = result.teams
    .slice(0, Math.min(5, result.teams.length))
    .map(
      (team) =>
        `#${team.rank} ${team.teamNumber} ${team.teamName} (RS ${formatAnswerStat(team.rankingScore)}, ${team.record || "record unavailable"})`,
    )
    .join("; ");

  return [
    `${result.scopeLabel} standings snapshot for ${result.season}.`,
    preview ? `Top teams: ${preview}.` : "",
    `Returned ${result.returnedCount} ranked teams from a field of ${result.totalRankedTeams}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildTeamEventMatchupEpaAnswer(result) {
  const preview = result.matches
    .slice(0, Math.min(3, result.matches.length))
    .map((match) => {
      const partners = match.partnerTeams
        .map((team) => `${team.teamNumber} (${formatAnswerStat(team.epa)})`)
        .join(", ");
      const opponents = match.opponentTeams
        .map((team) => `${team.teamNumber} (${formatAnswerStat(team.epa)})`)
        .join(", ");
      return `${match.matchLabel}: partners ${partners}; opponents ${opponents}`;
    })
    .join(" | ");

  return [
    `Showing ${result.totalMatchCount} ${result.eventName} matches for ${result.teamName} (Team ${result.teamNumber}), with partners and opponents enriched by ${result.season} EPA.`,
    result.eventStatusMessage || "",
    preview,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildEventRankingsWithEpaAnswer(result) {
  const preview = result.teams
    .slice(0, Math.min(5, result.teams.length))
    .map(
      (team) =>
        `#${team.rank} ${team.teamNumber} ${team.teamName} (RS ${formatAnswerStat(team.rankingScore)}, EPA ${formatAnswerStat(team.epa)})`,
    )
    .join("; ");

  return [
    `${result.eventName} current rankings with ${result.season} EPA included.`,
    result.eventStatusMessage || "",
    preview ? `Top teams: ${preview}.` : "",
    `Returned ${result.returnedCount} ranked teams.`,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildAttachedTeamEpaRankingsAnswer(result) {
  const preview = result.teams
    .slice(0, Math.min(5, result.teams.length))
    .map((team) => `#${team.rank} ${team.teamNumber} ${team.teamName} (EPA ${team.epa.toFixed(1)})`)
    .join("; ");
  const unresolvedNote = result.unresolvedQueries?.length
    ? `Unmatched entries: ${result.unresolvedQueries.join(", ")}.`
    : "";
  const truncatedNote = result.truncatedInput
    ? `Only the first ${ATTACHMENT_TEAM_FETCH_LIMIT} extracted team entries were processed.`
    : "";

  return [
    `Sorted ${result.matchedTeamCount} attached teams by ${result.metric} for ${result.season}.`,
    preview ? `Top teams: ${preview}.` : "",
    unresolvedNote,
    truncatedNote,
  ]
    .filter(Boolean)
    .join(" ");
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatAnswerStat(value) {
  return Number.isFinite(value) ? Number(value).toFixed(2).replace(/\.00$/, "") : "-";
}

function getLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return null;
}

module.exports = {
  app,
  answerQuestion,
  archiveAnswer,
  buildAttachedTeamEpaRankingsAnswer,
  buildAttachmentContext,
  buildAnswerText,
  buildChampionshipDivisionEpaAnswer,
  buildChampionshipDivisionStandingsAnswer,
  buildEpaRankingsAnswer,
  buildEventRankingsWithEpaAnswer,
  buildTeamEventMatchupEpaAnswer,
  buildTeamChampionshipAnswer,
  buildTeamRegionalPointsAnswer,
  buildTeamLookupAnswer,
  buildScoreCategoryAnswer,
  buildRegionalEventAnswer,
  buildRegionalRankingsAnswer,
  extractAllTeamsDirectory,
  extractAttachedEpaRankingRequest,
  extractChampionshipDivisionEpaRequest,
  extractChampionshipDivisionStandingsRequest,
  extractChampionshipStandingsRowsFromHtml,
  extractEventRankingsWithEpaRequest,
  extractTeamEventMatchRows,
  extractTeamEventMatchupEpaRequest,
  extractTeamQueriesFromAttachmentText,
  extractMetricQuery,
  extractEpaRankingRequest,
  extractStandingsStatusMessage,
  extractFirstChampionshipTeamQuery,
  extractRegionalPointsTeamQuery,
  extractEventTeamDirectory,
  extractTeamLookupName,
  extractScoreBreakdown,
  findBestTeamMatches,
  findChampionshipDivisionInQuestion,
  findMatchingScoreLabels,
  normalizeChampionshipDivision,
  normalizeStateFilter,
  parseQuestion,
  pruneHistoryKeepOldest,
  scoreTeamNameMatch,
  summarizeHistoryEntry,
};
