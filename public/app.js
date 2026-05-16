const queryField = document.querySelector("#query");
const attachmentInputNode = document.querySelector("#attachments");
const attachmentListNode = document.querySelector("#attachment-list");
const submitButton = document.querySelector("#submit");
const statusNode = document.querySelector("#status");
const debugLogNode = document.querySelector("#debug-log");

const resultPanelNode = document.querySelector("#result-panel");
const answerBadgeNode = document.querySelector("#answer-badge");
const selectedQuestionNode = document.querySelector("#selected-question");
const answerNode = document.querySelector("#answer");
const traceWrapNode = document.querySelector("#trace-wrap");
const traceLogNode = document.querySelector("#trace-log");
const resultNode = document.querySelector("#result");
const sourcesWrapNode = document.querySelector("#sources-wrap");
const sourcesNode = document.querySelector("#sources");
const leaderboardWrapNode = document.querySelector("#leaderboard-wrap");
const leaderboardTitleNode = document.querySelector("#leaderboard-title");
const leaderboardNode = document.querySelector("#leaderboard");

const historySelectNode = document.querySelector("#history-select");
const historyEmptyNode = document.querySelector("#history-empty");
const clearHistoryButton = document.querySelector("#clear-history");

const metricScoreLabelNode = document.querySelector("#metric-score-label");
const highestScoreNode = document.querySelector("#highest-score");
const matchNameNode = document.querySelector("#match-name");
const eventNameNode = document.querySelector("#event-name");
const allianceNode = document.querySelector("#alliance");
const FALLBACK_TEAM_AVATAR_URL = "/team-avatar-fallback.svg";

const debugLines = [];

let activeJobId = null;
let activePollToken = 0;
let activeHistoryLoadToken = 0;

submitButton.addEventListener("click", runQuery);
historySelectNode.addEventListener("change", onHistorySelected);
clearHistoryButton.addEventListener("click", clearHistoryQuestions);
queryField.addEventListener("input", onQueryEdited);
attachmentInputNode.addEventListener("change", onAttachmentChanged);
queryField.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    runQuery();
  }
});

window.addEventListener("popstate", () => {
  syncViewToUrl();
});

initializePage();

async function initializePage() {
  resetPageState();
  try {
    await fetchHistoryList();
  } catch (error) {
    pushDebug(error.message);
    statusNode.textContent = "Past questions unavailable.";
  }

  await syncViewToUrl();
}

async function syncViewToUrl() {
  const historyId = getHistoryIdFromUrl();

  if (!historyId) {
    cancelHistoryLoad();
    historySelectNode.value = "";
    renderAttachmentSummary(buildLocalAttachmentSummary(), false);
    hideResultPanel();
    return;
  }

  const historyLoadToken = beginHistoryLoad();
  historySelectNode.value = historyId;
  await loadHistoryEntry(historyId, historyLoadToken);
}

async function runQuery() {
  const question = queryField.value.trim();
  const attachmentFiles = [...attachmentInputNode.files];

  if (!question) {
    statusNode.textContent = "Enter a question first.";
    pushDebug("Enter a question first.");
    return;
  }

  activePollToken += 1;
  activeJobId = null;
  const pollToken = activePollToken;
  cancelHistoryLoad();

  historySelectNode.value = "";
  history.replaceState({}, "", "/");
  clearAnswerContent();
  clearDebugLog();
  pushDebug(`Creating query job for: ${question}`);
  if (attachmentFiles.length > 0) {
    pushDebug(`Including ${attachmentFiles.length} uploaded file${attachmentFiles.length === 1 ? "" : "s"}.`);
  }
  setBusy(true, "Creating query job...");

  try {
    const formData = new FormData();
    formData.set("question", question);
    for (const file of attachmentFiles) {
      formData.append("attachments", file);
    }

    const response = await fetch("/api/query-jobs", {
      method: "POST",
      headers: {
        Accept: "application/json",
      },
      body: formData,
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || "Failed to create query job.");
    }

    activeJobId = payload.id;
    pushDebug(`Job created: ${payload.id}`);
    statusNode.textContent = "Polling query job...";
    await pollQueryJob(payload.id, pollToken);
  } catch (error) {
    clearAnswerContent();
    answerNode.textContent = error.message;
    resultPanelNode.classList.remove("hidden");
    pushDebug(error.message);
    statusNode.textContent = "Request failed.";
    setBusy(false);
  }
}

async function fetchHistoryList() {
  const response = await fetch("/api/history", {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error("Failed to load past questions.");
  }

  const historyEntries = await response.json();
  renderHistoryList(historyEntries);
  return historyEntries;
}

async function loadHistoryEntry(historyId, historyLoadToken = beginHistoryLoad()) {
  clearAnswerContent();
  clearDebugLog();
  attachmentInputNode.value = "";
  pushDebug(`Loading archived question ${historyId}.`);
  statusNode.textContent = "Loading archived question...";

  const response = await fetch(`/api/history/${encodeURIComponent(historyId)}`, {
    headers: {
      Accept: "application/json",
    },
  });

  if (historyLoadToken !== activeHistoryLoadToken) {
    return;
  }

  if (!response.ok) {
    clearAnswerContent();
    answerNode.textContent = "Archived question not found.";
    resultPanelNode.classList.remove("hidden");
    pushDebug("Archived question not found.");
    statusNode.textContent = "Archived question not found.";
    return;
  }

  const payload = await response.json();
  if (historyLoadToken !== activeHistoryLoadToken) {
    return;
  }

  queryField.value = payload.question || "";
  renderAttachmentSummary(payload.attachments || [], true);
  renderAnswerPayload(payload, "Archive");
  pushDebug(`Loaded archived question from ${formatTimestamp(payload.createdAt)}.`);
  statusNode.textContent = "Archive loaded.";
}

function renderAnswerPayload(payload, badgeLabel) {
  resultPanelNode.classList.remove("hidden");
  answerBadgeNode.textContent = payload.model ? payload.model : badgeLabel;
  selectedQuestionNode.textContent = payload.question || "";
  renderAttachmentSummary(payload.attachments || [], false);
  renderAnswerText(payload);
  renderLlmTrace(payload.llmTrace || null);
  renderSources(payload.sources || []);

  if (payload.supported && payload.result) {
    renderStructuredResult(payload.result);
  } else {
    clearStructuredResult();
  }
}

function renderAnswerText(payload) {
  answerNode.replaceChildren();

  const answerText = getDisplayAnswerText(payload);
  if (!answerText) {
    return;
  }

  for (const block of answerText.split(/\n{2,}/).filter(Boolean)) {
    const paragraph = document.createElement("p");
    paragraph.textContent = block.replace(/\s+/g, " ").trim();
    answerNode.append(paragraph);
  }
}

function getDisplayAnswerText(payload) {
  const result = payload.result;
  if (!result) {
    return payload.answer || "";
  }

  if (result.type === "regional_rankings") {
    const label =
      result.scope === "minnesota_teams"
        ? "Minnesota teams in the 2026 regional pool"
        : "the 2026 FIRST regional pool";
    return `Showing ${result.returnedCount} teams from ${label}, ordered by regional points as of ${formatToday()}.`;
  }

  if (result.type === "regional_event_rankings") {
    return `Showing ${result.returnedCount} ranked teams for ${result.eventName} in ${result.season}.`;
  }

  if (result.type === "attached_team_epa_rankings") {
    return `Sorted ${result.matchedTeamCount} teams extracted from the uploaded files by ${result.metric} for ${result.season}.`;
  }

  if (result.type === "championship_division_epa_rankings") {
    return `Showing ${result.returnedCount} teams from the ${result.divisionName} Division, ordered by EPA for ${result.season}.`;
  }

  if (result.type === "championship_division_standings") {
    return result.teams?.length
      ? `Showing the current ${result.divisionName} Division standings snapshot for ${result.season}.`
      : `${result.divisionName} Division standings are not posted yet for ${result.season}.`;
  }

  if (result.type === "team_event_matchup_epa") {
    return `Showing ${result.totalMatchCount} ${result.eventName} matches for Team ${result.teamNumber}, with partner and opponent EPA match by match.`;
  }

  if (result.type === "event_rankings_with_epa") {
    return `Showing the current ${result.eventName} rankings with ${result.season} EPA included.`;
  }

  return payload.answer || "";
}

function renderStructuredResult(result) {
  if (result.type === "regional_rankings") {
    renderRegionalRankings(result);
    return;
  }

  if (result.type === "epa_rankings") {
    renderEpaRankings(result);
    return;
  }

  if (result.type === "attached_team_epa_rankings") {
    renderAttachedTeamEpaRankings(result);
    return;
  }

  if (result.type === "championship_division_epa_rankings") {
    renderChampionshipDivisionEpaRankings(result);
    return;
  }

  if (result.type === "championship_division_standings") {
    renderChampionshipDivisionStandings(result);
    return;
  }

  if (result.type === "team_event_matchup_epa") {
    renderTeamEventMatchupEpa(result);
    return;
  }

  if (result.type === "event_rankings_with_epa") {
    renderEventRankingsWithEpa(result);
    return;
  }

  if (result.type === "regional_event_rankings") {
    renderRegionalEventRankings(result);
    return;
  }

  if (result.type === "team_regional_points") {
    renderTeamRegionalProfile(result);
    return;
  }

  if (result.type === "highest_auto_score" || result.type === "highest_score_category") {
    renderScoreResult(result);
    return;
  }

  clearStructuredResult();
}

async function pollQueryJob(jobId, pollToken) {
  let seenProgressCount = 0;

  while (pollToken === activePollToken && activeJobId === jobId) {
    const response = await fetch(`/api/query-jobs/${encodeURIComponent(jobId)}`, {
      headers: {
        Accept: "application/json",
      },
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || "Failed to load query job.");
    }

    const newProgress = payload.progress.slice(seenProgressCount);
    seenProgressCount = payload.progress.length;

    for (const entry of newProgress) {
      const line = entry.source ? `${entry.message}\n${entry.source}` : entry.message;
      pushDebug(line);
      statusNode.textContent = entry.message;
    }

    if (payload.status === "completed") {
      activeJobId = null;
      renderAnswerPayload(payload.result, "Live scrape");
      pushDebug(`Job completed. Archived as ${payload.result.id}.`);
      statusNode.textContent = payload.result.supported ? "Query complete." : "Unsupported question.";
      setBusy(false);

      try {
        await fetchHistoryList();
      } catch (error) {
        pushDebug(error.message);
      }

      return;
    }

    if (payload.status === "error") {
      activeJobId = null;
      clearAnswerContent();
      answerNode.textContent = payload.error || "Request failed.";
      resultPanelNode.classList.remove("hidden");
      pushDebug(`Job failed: ${payload.error || "Request failed."}`);
      statusNode.textContent = "Request failed.";
      setBusy(false);
      return;
    }

    await delay(700);
  }

  if (pollToken === activePollToken && activeJobId === jobId) {
    activeJobId = null;
  }
}

function renderScoreResult(result) {
  const scoreValue = result.highestScore ?? result.highestAutoScore;
  metricScoreLabelNode.textContent = result.displayLabel || "Highest auto score";
  highestScoreNode.textContent = Number.isFinite(scoreValue) ? `${scoreValue} points` : "";
  matchNameNode.textContent = result.matchName;
  eventNameNode.textContent = result.eventName;
  allianceNode.replaceChildren();

  const prefix = document.createElement("span");
  prefix.textContent = `${capitalize(result.allianceColor)} alliance: `;
  allianceNode.append(prefix);

  const details = result.allianceTeamDetails || [];
  details.forEach((teamDetail, index) => {
    if (index > 0) {
      allianceNode.append(document.createTextNode(", "));
    }

    const teamWrap = document.createElement("span");
    teamWrap.className = "alliance-team";

    const avatar = createTeamAvatar(teamDetail, "team-avatar team-avatar-inline");
    const link = document.createElement("a");
    link.href = teamDetail.blueAllianceUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = teamDetail.number;
    link.title = buildTeamTooltip(teamDetail);

    teamWrap.append(avatar, link);
    allianceNode.append(teamWrap);
  });

  resultNode.classList.remove("hidden");
  leaderboardTitleNode.textContent = "Top matches scanned";
  renderLeaderboard(result.leaderboard || []);
}

function renderRegionalRankings(result) {
  clearMetricCards();
  resultNode.classList.add("hidden");
  leaderboardTitleNode.textContent =
    result.scope === "minnesota_teams"
      ? "Top Minnesota teams by regional points"
      : "Top teams by regional points";
  renderTeamRankings(result.teams || [], "totalPoints");
}

function renderEpaRankings(result) {
  clearMetricCards();
  resultNode.classList.add("hidden");
  leaderboardNode.replaceChildren();
  leaderboardTitleNode.textContent =
    result.scope === "state_teams"
      ? `Top ${result.scopeLabel} by EPA`
      : result.scope === "championship_division"
        ? `${result.scopeLabel} by EPA`
        : "Top teams by EPA";

  if (!Array.isArray(result.teams) || result.teams.length === 0) {
    leaderboardWrapNode.classList.add("hidden");
    return;
  }

  const table = document.createElement("table");
  table.className = "ranking-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Rank", "Team", "EPA", "Auto", "Teleop", "Endgame"].forEach((label) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  });
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");

  for (const team of result.teams) {
    const row = document.createElement("tr");

    const rankCell = document.createElement("td");
    rankCell.className = "ranking-rank";
    rankCell.textContent = `#${team.rank}`;

    const teamCell = document.createElement("td");
    teamCell.append(buildTeamCellContent(team));

    const epaCell = document.createElement("td");
    epaCell.className = "ranking-points";
    epaCell.textContent = formatNumericStat(team.epa);

    const autoCell = document.createElement("td");
    autoCell.textContent = formatNumericStat(team.autoEpa);

    const teleopCell = document.createElement("td");
    teleopCell.textContent = formatNumericStat(team.teleopEpa);

    const endgameCell = document.createElement("td");
    endgameCell.textContent = formatNumericStat(team.endgameEpa);

    row.append(rankCell, teamCell, epaCell, autoCell, teleopCell, endgameCell);
    body.append(row);
  }

  table.append(body);
  leaderboardNode.append(table);
  leaderboardWrapNode.classList.remove("hidden");
}

function renderChampionshipDivisionEpaRankings(result) {
  renderEpaRankings(result);
}

function renderAttachedTeamEpaRankings(result) {
  renderEpaRankings({
    ...result,
    scope: "uploaded_team_list",
    scopeLabel: "uploaded teams",
  });
  leaderboardTitleNode.textContent = "Uploaded teams sorted by EPA";
}

function renderRegionalEventRankings(result) {
  clearMetricCards();
  resultNode.classList.add("hidden");
  leaderboardTitleNode.textContent = `${result.eventName} regional points`;
  renderTeamRankings(result.teams || [], "regionalPoints");
}

function renderChampionshipDivisionStandings(result) {
  clearMetricCards();
  resultNode.classList.add("hidden");
  leaderboardNode.replaceChildren();
  leaderboardTitleNode.textContent = `${result.divisionName} Division standings`;

  if (result.eventStatusMessage) {
    const note = document.createElement("p");
    note.className = "ranking-note";
    note.textContent = result.eventStatusMessage;
    leaderboardNode.append(note);
  }

  if (!Array.isArray(result.teams) || result.teams.length === 0) {
    leaderboardWrapNode.classList.remove("hidden");
    return;
  }

  const table = document.createElement("table");
  table.className = "ranking-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Rank", "Team", "Ranking Score", "Match", "Auto Fuel", "Tower", "W-L-T", "Played"].forEach(
    (label) => {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      headRow.append(cell);
    },
  );
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");

  for (const team of result.teams) {
    const row = document.createElement("tr");

    const rankCell = document.createElement("td");
    rankCell.className = "ranking-rank";
    rankCell.textContent = `#${team.rank}`;

    const teamCell = document.createElement("td");
    teamCell.append(buildTeamCellContent(team));

    const rankingScoreCell = document.createElement("td");
    rankingScoreCell.className = "ranking-points";
    rankingScoreCell.textContent = formatRankingStat(team.rankingScore);

    const matchCell = document.createElement("td");
    matchCell.textContent = formatRankingStat(team.matchScore);

    const autoFuelCell = document.createElement("td");
    autoFuelCell.textContent = formatRankingStat(team.autoFuel);

    const towerCell = document.createElement("td");
    towerCell.textContent = formatRankingStat(team.tower);

    const recordCell = document.createElement("td");
    recordCell.textContent = team.record || "-";

    const playedCell = document.createElement("td");
    playedCell.textContent = Number.isFinite(team.matchesPlayed) ? String(team.matchesPlayed) : "-";

    row.append(
      rankCell,
      teamCell,
      rankingScoreCell,
      matchCell,
      autoFuelCell,
      towerCell,
      recordCell,
      playedCell,
    );
    body.append(row);
  }

  table.append(body);
  leaderboardNode.append(table);
  leaderboardWrapNode.classList.remove("hidden");
}

function renderTeamEventMatchupEpa(result) {
  clearMetricCards();
  resultNode.classList.add("hidden");
  leaderboardNode.replaceChildren();
  leaderboardTitleNode.textContent = `${result.teamName} matchups at ${result.eventName}`;

  if (result.eventStatusMessage) {
    const note = document.createElement("p");
    note.className = "ranking-note";
    note.textContent = result.eventStatusMessage;
    leaderboardNode.append(note);
  }

  if (!Array.isArray(result.matches) || result.matches.length === 0) {
    leaderboardWrapNode.classList.remove("hidden");
    return;
  }

  const table = document.createElement("table");
  table.className = "ranking-table matchup-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Match", "Time", "Alliance", "Partners", "Opponents", "Score"].forEach((label) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  });
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");

  for (const match of result.matches) {
    const row = document.createElement("tr");

    const matchCell = document.createElement("td");
    const matchLink = document.createElement("a");
    matchLink.href = match.matchUrl || "#";
    matchLink.target = "_blank";
    matchLink.rel = "noreferrer";
    matchLink.className = "ranking-link";
    matchLink.textContent = match.matchLabel;
    matchCell.append(matchLink);

    const timeCell = document.createElement("td");
    timeCell.textContent = match.startTimeLabel || "-";

    const allianceCell = document.createElement("td");
    const alliancePill = document.createElement("span");
    alliancePill.className = `matchup-alliance matchup-alliance-${match.allianceColor || "neutral"}`;
    alliancePill.textContent = `${capitalize(match.allianceColor || "scheduled")} with ${result.teamNumber}`;
    allianceCell.append(alliancePill);

    const partnersCell = document.createElement("td");
    partnersCell.append(buildMatchupTeamList(match.partnerTeams || []));

    const opponentsCell = document.createElement("td");
    opponentsCell.append(buildMatchupTeamList(match.opponentTeams || []));

    const scoreCell = document.createElement("td");
    scoreCell.className = "ranking-points";
    scoreCell.textContent =
      Number.isFinite(match.targetTeamScore) && Number.isFinite(match.opponentScore)
        ? `${match.targetTeamScore} - ${match.opponentScore}`
        : "Scheduled";

    row.append(matchCell, timeCell, allianceCell, partnersCell, opponentsCell, scoreCell);
    body.append(row);
  }

  table.append(body);
  leaderboardNode.append(table);
  leaderboardWrapNode.classList.remove("hidden");
}

function renderEventRankingsWithEpa(result) {
  clearMetricCards();
  resultNode.classList.add("hidden");
  leaderboardNode.replaceChildren();
  leaderboardTitleNode.textContent = `${result.eventName} rankings with EPA`;

  if (result.eventStatusMessage) {
    const note = document.createElement("p");
    note.className = "ranking-note";
    note.textContent = result.eventStatusMessage;
    leaderboardNode.append(note);
  }

  if (!Array.isArray(result.teams) || result.teams.length === 0) {
    leaderboardWrapNode.classList.remove("hidden");
    return;
  }

  const table = document.createElement("table");
  table.className = "ranking-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  [
    "Rank",
    "Team",
    "Ranking Score",
    "Match",
    "Auto Fuel",
    "Tower",
    "W-L-T",
    "Played",
    "EPA",
    "Auto",
    "Teleop",
    "Endgame",
  ].forEach((label) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  });
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");
  for (const team of result.teams) {
    const row = document.createElement("tr");

    const rankCell = document.createElement("td");
    rankCell.className = "ranking-rank";
    rankCell.textContent = `#${team.rank}`;

    const teamCell = document.createElement("td");
    teamCell.append(buildTeamCellContent(team));

    const rankingScoreCell = document.createElement("td");
    rankingScoreCell.className = "ranking-points";
    rankingScoreCell.textContent = formatRankingStat(team.rankingScore);

    const matchCell = document.createElement("td");
    matchCell.textContent = formatRankingStat(team.matchScore);

    const autoFuelCell = document.createElement("td");
    autoFuelCell.textContent = formatRankingStat(team.autoFuel);

    const towerCell = document.createElement("td");
    towerCell.textContent = formatRankingStat(team.tower);

    const recordCell = document.createElement("td");
    recordCell.textContent = team.record || "-";

    const playedCell = document.createElement("td");
    playedCell.textContent = Number.isFinite(team.matchesPlayed) ? String(team.matchesPlayed) : "-";

    const epaCell = document.createElement("td");
    epaCell.className = "ranking-points";
    epaCell.textContent = formatNumericStat(team.epa);

    const autoEpaCell = document.createElement("td");
    autoEpaCell.textContent = formatNumericStat(team.autoEpa);

    const teleopCell = document.createElement("td");
    teleopCell.textContent = formatNumericStat(team.teleopEpa);

    const endgameCell = document.createElement("td");
    endgameCell.textContent = formatNumericStat(team.endgameEpa);

    row.append(
      rankCell,
      teamCell,
      rankingScoreCell,
      matchCell,
      autoFuelCell,
      towerCell,
      recordCell,
      playedCell,
      epaCell,
      autoEpaCell,
      teleopCell,
      endgameCell,
    );
    body.append(row);
  }

  table.append(body);
  leaderboardNode.append(table);
  leaderboardWrapNode.classList.remove("hidden");
}

function renderTeamRegionalProfile(result) {
  clearMetricCards();
  resultNode.classList.add("hidden");
  leaderboardNode.replaceChildren();
  leaderboardTitleNode.textContent = `${result.teamName} regional profile`;

  const table = document.createElement("table");
  table.className = "ranking-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Team", "Rank", "Points", "Event 1", "Event 2", "FIRST Championship"].forEach((label) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  });
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");
  const row = document.createElement("tr");

  const teamCell = document.createElement("td");
  teamCell.append(buildTeamCellContent({
    teamNumber: result.teamNumber,
    teamName: result.teamName,
    location: result.location,
    avatarUrl: result.avatarUrl,
    blueAllianceUrl: result.blueAllianceUrl,
  }));

  const rankCell = document.createElement("td");
  rankCell.className = "ranking-rank";
  rankCell.textContent = `#${result.rank}`;

  const pointsCell = document.createElement("td");
  pointsCell.className = "ranking-points";
  pointsCell.textContent = `${result.totalPoints} pts`;

  const event1Cell = document.createElement("td");
  event1Cell.textContent = formatRegionalEventValue(result.regional1Points, result.regional1EventCode);

  const event2Cell = document.createElement("td");
  event2Cell.textContent =
    result.regional2Points == null && result.regional2Projection != null
      ? formatRegionalEventValue(result.regional2Projection, result.regional2EventCode, true)
      : formatRegionalEventValue(result.regional2Points, result.regional2EventCode);

  const championshipCell = document.createElement("td");
  const pill = document.createElement("span");
  pill.className = `status-pill${result.qualifiedFirstCmp ? " status-pill-active" : ""}`;
  pill.textContent = result.firstChampionshipLabel || "Not yet qualified";
  championshipCell.append(pill);

  row.append(teamCell, rankCell, pointsCell, event1Cell, event2Cell, championshipCell);
  body.append(row);
  table.append(body);
  leaderboardNode.append(table);
  leaderboardWrapNode.classList.remove("hidden");
}

function renderTeamRankings(teams, pointsKey) {
  leaderboardNode.replaceChildren();

  if (teams.length === 0) {
    leaderboardWrapNode.classList.add("hidden");
    return;
  }

  const table = document.createElement("table");
  table.className = "ranking-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Rank", "Team", "Points"].forEach((label) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  });
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");

  for (const team of teams) {
    const row = document.createElement("tr");

    const rankCell = document.createElement("td");
    rankCell.className = "ranking-rank";
    rankCell.textContent = `#${team.rank}`;

    const teamCell = document.createElement("td");
    teamCell.append(buildTeamCellContent(team));

    const pointsCell = document.createElement("td");
    pointsCell.className = "ranking-points";
    pointsCell.textContent = `${team[pointsKey]} pts`;

    row.append(rankCell, teamCell, pointsCell);
    body.append(row);
  }

  table.append(body);
  leaderboardNode.append(table);
  leaderboardWrapNode.classList.remove("hidden");
}

function renderSources(sources) {
  sourcesNode.replaceChildren();

  for (const source of sources) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = source.label;
    item.append(link);
    sourcesNode.append(item);
  }

  sourcesWrapNode.classList.toggle("hidden", sources.length === 0);
}

function renderLeaderboard(leaderboard) {
  leaderboardNode.replaceChildren();

  const list = document.createElement("ul");
  list.className = "leaderboard-list";

  for (const row of leaderboard) {
    const scoreValue = row.highestScore ?? row.highestAutoScore;
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = row.matchUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = row.metricLabel
      ? `${scoreValue} pts • ${row.metricLabel} • ${row.eventName} • ${row.matchName}`
      : `${scoreValue} pts • ${row.eventName} • ${row.matchName}`;
    item.append(link);
    list.append(item);
  }

  leaderboardNode.append(list);
  leaderboardWrapNode.classList.toggle("hidden", leaderboard.length === 0);
}

function renderHistoryList(entries) {
  const previousValue = historySelectNode.value;
  historySelectNode.replaceChildren();

  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "Choose a past question...";
  historySelectNode.append(emptyOption);

  if (entries.length === 0) {
    historySelectNode.disabled = true;
    clearHistoryButton.disabled = true;
    historyEmptyNode.classList.remove("hidden");
    return;
  }

  historySelectNode.disabled = false;
  clearHistoryButton.disabled = entries.length <= 1;

  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = `${entry.question} (${formatTimestamp(entry.createdAt)})`;
    historySelectNode.append(option);
  }

  historyEmptyNode.classList.add("hidden");
  if ([...historySelectNode.options].some((option) => option.value === previousValue)) {
    historySelectNode.value = previousValue;
  }
}

async function onHistorySelected() {
  const historyId = historySelectNode.value;

  if (!historyId) {
    cancelHistoryLoad();
    history.replaceState({}, "", "/");
    clearAnswerContent();
    renderAttachmentSummary(buildLocalAttachmentSummary(), false);
    statusNode.textContent = "Ready.";
    return;
  }

  const historyLoadToken = beginHistoryLoad();
  history.replaceState({}, "", `/?history=${encodeURIComponent(historyId)}`);
  await loadHistoryEntry(historyId, historyLoadToken);
}

async function clearHistoryQuestions() {
  clearHistoryButton.disabled = true;
  pushDebug("Clearing archived questions, keeping the oldest one.");
  statusNode.textContent = "Clearing archived questions...";

  try {
    const response = await fetch("/api/history", {
      method: "DELETE",
      headers: {
        Accept: "application/json",
      },
    });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.detail || payload.error || "Failed to clear archived questions.");
    }

    renderHistoryList(payload.history || []);

    if (getHistoryIdFromUrl()) {
      history.replaceState({}, "", "/");
      clearAnswerContent();
    }

    pushDebug(`Cleared ${payload.clearedCount} archived questions.`);
    statusNode.textContent = "Archived questions cleared.";
  } catch (error) {
    pushDebug(error.message);
    statusNode.textContent = "Failed to clear archived questions.";
  } finally {
    clearHistoryButton.disabled = historySelectNode.disabled || historySelectNode.options.length <= 2;
  }
}

function buildLocalAttachmentSummary() {
  return [...attachmentInputNode.files].map((file) => ({
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size || 0,
    supported: true,
    teamQueryCount: null,
    truncated: false,
  }));
}

function renderAttachmentSummary(attachments, isArchiveView) {
  attachmentListNode.replaceChildren();

  if (!Array.isArray(attachments) || attachments.length === 0) {
    attachmentListNode.classList.add("hidden");
    return;
  }

  for (const attachment of attachments) {
    const item = document.createElement("li");
    item.className = "attachment-pill";
    item.textContent = buildAttachmentLabel(attachment, isArchiveView);
    attachmentListNode.append(item);
  }

  attachmentListNode.classList.remove("hidden");
}

function buildAttachmentLabel(attachment, isArchiveView) {
  const parts = [
    isArchiveView ? "Archived" : "File",
    attachment.name || "attachment",
  ];

  if (Number.isFinite(attachment.size)) {
    parts.push(formatBytes(attachment.size));
  }

  if (attachment.supported === false) {
    parts.push("unsupported");
  } else if (Number.isFinite(attachment.teamQueryCount) && attachment.teamQueryCount > 0) {
    parts.push(`${attachment.teamQueryCount} team entr${attachment.teamQueryCount === 1 ? "y" : "ies"}`);
  }

  if (attachment.truncated) {
    parts.push("preview truncated");
  }

  return parts.join(" • ");
}

function resetPageState() {
  clearAnswerContent();
  clearDebugLog();
  attachmentInputNode.value = "";
  renderAttachmentSummary([], false);
  statusNode.textContent = "Ready.";
}

function onQueryEdited() {
  if (!historySelectNode.value && !getHistoryIdFromUrl()) {
    return;
  }

  cancelHistoryLoad();
  historySelectNode.value = "";
  history.replaceState({}, "", "/");
  renderAttachmentSummary(buildLocalAttachmentSummary(), false);
  statusNode.textContent = "Editing new question...";
}

function onAttachmentChanged() {
  renderAttachmentSummary(buildLocalAttachmentSummary(), false);

  if (!historySelectNode.value && !getHistoryIdFromUrl()) {
    return;
  }

  cancelHistoryLoad();
  historySelectNode.value = "";
  history.replaceState({}, "", "/");
  statusNode.textContent = "Editing new question...";
}

function clearAnswerContent() {
  answerBadgeNode.textContent = "GPT-5.4";
  selectedQuestionNode.textContent = "";
  answerNode.replaceChildren();
  clearTraceLog();
  sourcesNode.replaceChildren();
  sourcesWrapNode.classList.add("hidden");
  clearStructuredResult();
  hideResultPanel();
}

function clearStructuredResult() {
  clearMetricCards();
  resultNode.classList.add("hidden");
  leaderboardWrapNode.classList.add("hidden");
  leaderboardNode.replaceChildren();
  leaderboardTitleNode.textContent = "Top matches scanned";
}

function clearMetricCards() {
  metricScoreLabelNode.textContent = "Highest auto score";
  allianceNode.replaceChildren();
  highestScoreNode.textContent = "";
  matchNameNode.textContent = "";
  eventNameNode.textContent = "";
}

function hideResultPanel() {
  resultPanelNode.classList.add("hidden");
}

function setBusy(isBusy, message = "Ready.") {
  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? "Running..." : "Run query";
  statusNode.textContent = message;
}

function clearDebugLog() {
  debugLines.length = 0;
  debugLogNode.textContent = "Ready.";
}

function clearTraceLog() {
  traceLogNode.textContent = "No trace available.";
  traceWrapNode.classList.add("hidden");
}

function pushDebug(line) {
  debugLines.unshift(formatDebugLine(line));
  if (debugLines.length > 12) {
    debugLines.length = 12;
  }
  debugLogNode.textContent = debugLines.join("\n\n");
}

function getHistoryIdFromUrl() {
  const search = new URLSearchParams(window.location.search);
  return search.get("history");
}

function formatDebugLine(line) {
  const stamp = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${stamp}  ${line}`;
}

function formatTimestamp(value) {
  if (!value) {
    return "Unknown time";
  }

  return new Date(value).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 1024) {
    return `${Math.max(0, Math.round(value || 0))} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatNumericStat(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  return Number(value).toFixed(1);
}

function formatRankingStat(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  return Number(value).toFixed(2).replace(/\.00$/, "");
}

function formatToday() {
  return new Date().toLocaleDateString([], {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function renderLlmTrace(trace) {
  if (!trace) {
    clearTraceLog();
    return;
  }

  const lines = [];
  lines.push(`Mode: ${trace.mode === "bypass" ? "Deterministic bypass" : "LLM research"}`);
  lines.push(`Question: ${trace.question || "Unavailable"}`);

  if (trace.route) {
    lines.push(`Route: ${trace.route}`);
  }

  if (trace.detail) {
    lines.push(`Detail: ${trace.detail}`);
  }

  if (Array.isArray(trace.attachments) && trace.attachments.length > 0) {
    lines.push(`Attachments: ${trace.attachments.map((attachment) => attachment.name).join(", ")}`);
  }

  lines.push("");
  lines.push("System prompt:");
  lines.push(trace.systemPrompt || "Not used for this query.");

  lines.push("");
  lines.push("Tool calls:");
  if (Array.isArray(trace.toolCalls) && trace.toolCalls.length > 0) {
    for (const toolCall of trace.toolCalls) {
      lines.push(
        `Turn ${toolCall.turn} - ${toolCall.name} ${JSON.stringify(toolCall.arguments || {}, null, 2)}`,
      );
    }
  } else {
    lines.push("No tool calls recorded.");
  }

  lines.push("");
  lines.push("Final payload:");
  if (trace.finalReturnAnswer) {
    lines.push(JSON.stringify(trace.finalReturnAnswer, null, 2));
  } else if (trace.finalPayload) {
    lines.push(JSON.stringify(trace.finalPayload, null, 2));
  } else if (trace.finalResponseText) {
    lines.push(trace.finalResponseText);
  } else {
    lines.push("No final payload recorded.");
  }

  if (trace.fallback) {
    lines.push("");
    lines.push("Fallback:");
    lines.push(JSON.stringify(trace.fallback, null, 2));
  }

  traceLogNode.textContent = lines.join("\n");
  traceWrapNode.classList.remove("hidden");
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function beginHistoryLoad() {
  activeHistoryLoadToken += 1;
  return activeHistoryLoadToken;
}

function cancelHistoryLoad() {
  activeHistoryLoadToken += 1;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function createTeamAvatar(team, className = "team-avatar") {
  const avatar = document.createElement("img");
  avatar.className = className;
  avatar.alt = "";
  avatar.loading = "lazy";
  avatar.decoding = "async";
  avatar.src = team.avatarUrl || FALLBACK_TEAM_AVATAR_URL;
  avatar.addEventListener(
    "error",
    () => {
      if (!avatar.dataset.fallbackApplied) {
        avatar.dataset.fallbackApplied = "true";
        avatar.src = FALLBACK_TEAM_AVATAR_URL;
      }
    },
    { once: true },
  );
  return avatar;
}

function buildTeamCellContent(team) {
  const wrap = document.createElement("div");
  wrap.className = "ranking-team";

  const avatar = createTeamAvatar(team);
  const textWrap = document.createElement("div");
  textWrap.className = "ranking-team-copy";

  const link = document.createElement("a");
  link.href = team.blueAllianceUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.className = "ranking-link";
  link.textContent = `Team ${team.teamNumber}`;
  link.title = buildTeamTooltip(team);

  const teamMeta = document.createElement("div");
  teamMeta.className = "ranking-team-meta";
  teamMeta.textContent = team.teamName;

  textWrap.append(link, teamMeta);

  if (team.location) {
    const location = document.createElement("div");
    location.className = "ranking-location";
    location.textContent = team.location;
    textWrap.append(location);
  }

  wrap.append(avatar, textWrap);
  return wrap;
}

function buildMatchupTeamList(teams) {
  const list = document.createElement("div");
  list.className = "matchup-team-list";

  for (const team of teams) {
    const item = document.createElement("div");
    item.className = "matchup-team";

    const avatar = createTeamAvatar(team, "team-avatar matchup-team-avatar");

    const textWrap = document.createElement("div");
    textWrap.className = "matchup-team-copy";

    const topLine = document.createElement("div");
    topLine.className = "matchup-team-topline";

    const link = document.createElement("a");
    link.href = team.blueAllianceUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.className = "ranking-link";
    link.textContent = `Team ${team.teamNumber}`;
    link.title = buildTeamTooltip(team);

    const epa = document.createElement("span");
    epa.className = "matchup-team-epa";
    epa.textContent = `EPA ${formatNumericStat(team.epa)}`;

    topLine.append(link, epa);

    const name = document.createElement("div");
    name.className = "ranking-team-meta";
    name.textContent = team.teamName;

    textWrap.append(topLine, name);
    item.append(avatar, textWrap);
    list.append(item);
  }

  return list;
}

function buildTeamTooltip(team) {
  return [team.teamName || team.name || "Unknown team", team.location]
    .filter(Boolean)
    .join(" - ");
}

function formatRegionalEventValue(points, eventCode, isProjection = false) {
  if (points == null) {
    return "Not yet scored";
  }

  const suffix = eventCode ? ` (${eventCode})` : "";
  return isProjection ? `${points} pts projected${suffix}` : `${points} pts${suffix}`;
}
