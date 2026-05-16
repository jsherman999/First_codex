const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAttachedTeamEpaRankingsAnswer,
  buildAttachmentContext,
  buildAnswerText,
  buildChampionshipDivisionEpaAnswer,
  buildChampionshipDivisionStandingsAnswer,
  buildEpaRankingsAnswer,
  buildEventRankingsWithEpaAnswer,
  buildTeamEventMatchupEpaAnswer,
  buildTeamChampionshipAnswer,
  buildRegionalEventAnswer,
  buildRegionalRankingsAnswer,
  buildScoreCategoryAnswer,
  buildTeamRegionalPointsAnswer,
  buildTeamLookupAnswer,
  extractAllTeamsDirectory,
  extractAttachedEpaRankingRequest,
  extractChampionshipDivisionEpaRequest,
  extractChampionshipDivisionStandingsRequest,
  extractChampionshipStandingsRowsFromHtml,
  extractEpaRankingRequest,
  extractEventRankingsWithEpaRequest,
  extractFirstChampionshipTeamQuery,
  extractMetricQuery,
  extractRegionalPointsTeamQuery,
  extractEventTeamDirectory,
  extractStandingsStatusMessage,
  extractTeamEventMatchRows,
  extractTeamEventMatchupEpaRequest,
  extractTeamQueriesFromAttachmentText,
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
} = require("./server");

test("parseQuestion supports the Minnesota 2026 autonomous-score query", () => {
  const parsed = parseQuestion(
    "What is the highest 'auto' score in FIRST robotics competitions in Minnesota this year, 2026?",
  );

  assert.deepEqual(parsed, {
    intent: "highest_auto_score",
    season: 2026,
    region: "Minnesota",
  });
});

test("parseQuestion rejects unsupported question shapes", () => {
  const parsed = parseQuestion("Which team has the best EPA in Iowa this season?");
  assert.equal(parsed.intent, "unsupported");
});

test("normalizeStateFilter maps Minnesota to MN for Statbotics queries", () => {
  assert.equal(normalizeStateFilter("Minnesota"), "MN");
  assert.equal(normalizeStateFilter("mn"), "MN");
});

test("extractEpaRankingRequest recognizes Minnesota EPA ranking questions", () => {
  assert.deepEqual(
    extractEpaRankingRequest("what are the top 10 Minnesota teams sorted by EPA in 2026?"),
    {
      limit: 10,
      state: "MN",
    },
  );
});

test("normalizeChampionshipDivision resolves Curie inputs", () => {
  assert.deepEqual(normalizeChampionshipDivision("Curie"), {
    code: "CURIE",
    name: "Curie",
  });
  assert.deepEqual(normalizeChampionshipDivision("CURIE"), {
    code: "CURIE",
    name: "Curie",
  });
});

test("findChampionshipDivisionInQuestion recognizes division wording", () => {
  assert.deepEqual(findChampionshipDivisionInQuestion("sort all the teams in the Curie division this year by EPA"), {
    code: "CURIE",
    name: "Curie",
  });
});

test("extractChampionshipDivisionEpaRequest recognizes Curie EPA ranking questions", () => {
  assert.deepEqual(
    extractChampionshipDivisionEpaRequest("Sort all the teams in the Curie division this year by EPA."),
    {
      divisionCode: "CURIE",
      divisionName: "Curie",
      limit: 75,
    },
  );
});

test("extractChampionshipDivisionStandingsRequest recognizes Curie standings questions", () => {
  assert.deepEqual(
    extractChampionshipDivisionStandingsRequest("Give me a snapshot of the current Curie division standings."),
    {
      divisionCode: "CURIE",
      divisionName: "Curie",
      limit: 20,
    },
  );
});

test("extractTeamEventMatchupEpaRequest recognizes Minnesota state matchup EPA questions", () => {
  assert.deepEqual(
    extractTeamEventMatchupEpaRequest(
      "Show the EPA of 7028's partners and opponents in the Minnesota state championship, match by match.",
    ),
    {
      teamQuery: "7028",
      eventCode: "MNST",
      eventName: "Minnesota State High School League Championship",
    },
  );
});

test("extractEventRankingsWithEpaRequest recognizes Minnesota state rankings with EPA questions", () => {
  assert.deepEqual(
    extractEventRankingsWithEpaRequest(
      "Here are the current rankings in the minnesota state high school league championship. create a table showing the same data with their 2026 EPA included.",
    ),
    {
      eventCode: "MNST",
      eventName: "Minnesota State High School League Championship",
    },
  );
});

test("extractAttachedEpaRankingRequest recognizes attachment-based EPA sorting", () => {
  assert.deepEqual(
    extractAttachedEpaRankingRequest("sort the attached list of teams by epa", {
      teamQueries: ["2052", "Iron Mosquitos"],
    }),
    {
      limit: 2,
    },
  );
});

test("buildAnswerText includes the core result fields", () => {
  const answer = buildAnswerText({
    highestAutoScore: 113,
    matchName: "Playoff Final 2",
    eventName: "Minnesota Granite City Regional",
    allianceColor: "red",
    allianceTeams: ["2470", "6045", "7028"],
    scannedMatchCount: 554,
    eventCount: 6,
  });

  assert.match(answer, /113 points/);
  assert.match(answer, /Playoff Final 2/);
  assert.match(answer, /Minnesota Granite City Regional/);
  assert.match(answer, /2470, 6045, 7028/);
  assert.match(answer, /554 official FIRST match pages/);
});

test("buildRegionalRankingsAnswer summarizes the top regional teams", () => {
  const answer = buildRegionalRankingsAnswer({
    scopeLabel: "2026 FIRST regional pool",
    season: 2026,
    returnedCount: 20,
    totalRankedTeams: 1627,
    teams: [
      { rank: 1, teamNumber: "4403", teamName: "PrepaTec", totalPoints: 195 },
      { rank: 2, teamNumber: "3544", teamName: "Spartiates", totalPoints: 187 },
    ],
  });

  assert.match(answer, /regional pool/);
  assert.match(answer, /#1 4403 PrepaTec \(195 pts\)/);
  assert.match(answer, /20 teams/);
  assert.match(answer, /1627/);
});

test("buildRegionalEventAnswer summarizes a specific event ranking table", () => {
  const answer = buildRegionalEventAnswer({
    eventName: "Minnesota 10,000 Lakes Regional",
    season: 2026,
    eventStatus: "Completed",
    returnedCount: 20,
    totalRankedTeams: 51,
    teams: [
      { rank: 1, teamNumber: "2491", teamName: "NoMythic", regionalPoints: 73 },
      { rank: 2, teamNumber: "4174", teamName: "Mustang Robotics", regionalPoints: 67 },
    ],
  });

  assert.match(answer, /Minnesota 10,000 Lakes Regional/);
  assert.match(answer, /Completed/);
  assert.match(answer, /#1 2491 NoMythic \(73 pts\)/);
  assert.match(answer, /51/);
});

test("buildEpaRankingsAnswer summarizes EPA leaderboard results", () => {
  const answer = buildEpaRankingsAnswer({
    scopeLabel: "Minnesota teams",
    metric: "EPA",
    season: 2026,
    returnedCount: 10,
    totalRankedTeams: 187,
    teams: [
      { rank: 1, teamNumber: "2052", teamName: "KnightKrawler", epa: 156.64 },
      { rank: 2, teamNumber: "2847", teamName: "The MegaHertz", epa: 154.96 },
    ],
  });

  assert.match(answer, /Minnesota teams ranked by EPA for 2026/);
  assert.match(answer, /#1 2052 KnightKrawler \(EPA 156.6\)/);
  assert.match(answer, /Returned 10 teams from a field of 187/);
});

test("buildChampionshipDivisionEpaAnswer summarizes division EPA results", () => {
  const answer = buildChampionshipDivisionEpaAnswer({
    scopeLabel: "Curie Division teams",
    season: 2026,
    participantUpdatedAt: "Participant list last modified Apr 24, 2026 09:16 event time.",
    returnedCount: 75,
    competingTeamCount: 75,
    teams: [
      { rank: 1, teamNumber: "59", teamName: "RamTech", epa: 140.2 },
      { rank: 2, teamNumber: "125", teamName: "NUTRONs", epa: 139.4 },
    ],
  });

  assert.match(answer, /Curie Division teams ranked by EPA for 2026/);
  assert.match(answer, /Participant list last modified Apr 24, 2026 09:16 event time/);
  assert.match(answer, /#1 59 RamTech \(EPA 140.2\)/);
  assert.match(answer, /field of 75/);
});

test("buildChampionshipDivisionStandingsAnswer summarizes pre-event standings", () => {
  const answer = buildChampionshipDivisionStandingsAnswer({
    scopeLabel: "Curie Division",
    season: 2026,
    competingTeamCount: 75,
    eventStatusMessage:
      "This event is scheduled to begin Wednesday, April 29, 2026. Please return after the start of Qualification Matches for ranking data.",
    teams: [],
  });

  assert.match(answer, /standings for 2026 are not posted yet/);
  assert.match(answer, /April 29, 2026/);
  assert.match(answer, /Competing teams currently listed: 75/);
});

test("buildTeamEventMatchupEpaAnswer summarizes team event matchup EPA results", () => {
  const answer = buildTeamEventMatchupEpaAnswer({
    totalMatchCount: 2,
    eventName: "Minnesota State High School League Championship",
    season: 2026,
    teamNumber: "7028",
    teamName: "Binary Battalion",
    eventStatusMessage: "This event is in progress.",
    matches: [
      {
        matchLabel: "Qualification 1",
        partnerTeams: [
          { teamNumber: "2472", epa: 100.2 },
          { teamNumber: "2846", epa: 95.1 },
        ],
        opponentTeams: [
          { teamNumber: "3276", epa: 126.3 },
          { teamNumber: "7797", epa: 84.2 },
          { teamNumber: "3100", epa: 124.0 },
        ],
      },
    ],
  });

  assert.match(answer, /Showing 2 Minnesota State High School League Championship matches/);
  assert.match(answer, /This event is in progress/);
  assert.match(answer, /Qualification 1: partners 2472 \(100.20\), 2846 \(95.10\); opponents 3276 \(126.30\)/);
});

test("buildEventRankingsWithEpaAnswer summarizes event rankings with EPA", () => {
  const answer = buildEventRankingsWithEpaAnswer({
    eventName: "Minnesota State High School League Championship",
    season: 2026,
    eventStatusMessage: "This event is in progress.",
    returnedCount: 36,
    teams: [
      { rank: 1, teamNumber: "2052", teamName: "KnightKrawler", rankingScore: 4.8, epa: 184.74 },
      { rank: 2, teamNumber: "2491", teamName: "NoMythic", rankingScore: 4.2, epa: 176.73 },
    ],
  });

  assert.match(answer, /current rankings with 2026 EPA included/);
  assert.match(answer, /This event is in progress/);
  assert.match(answer, /#1 2052 KnightKrawler \(RS 4.80, EPA 184.74\)/);
  assert.match(answer, /Returned 36 ranked teams/);
});

test("buildAttachedTeamEpaRankingsAnswer summarizes uploaded-team EPA results", () => {
  const answer = buildAttachedTeamEpaRankingsAnswer({
    metric: "EPA",
    season: 2026,
    matchedTeamCount: 3,
    unresolvedQueries: ["Unknown Squad"],
    truncatedInput: false,
    teams: [
      { rank: 1, teamNumber: "2052", teamName: "KnightKrawler", epa: 156.64 },
      { rank: 2, teamNumber: "2847", teamName: "The MegaHertz", epa: 154.96 },
    ],
  });

  assert.match(answer, /Sorted 3 attached teams by EPA for 2026/);
  assert.match(answer, /#1 2052 KnightKrawler \(EPA 156.6\)/);
  assert.match(answer, /Unmatched entries: Unknown Squad/);
});

test("extractTeamQueriesFromAttachmentText pulls team numbers and names from csv-like text", () => {
  assert.deepEqual(
    extractTeamQueriesFromAttachmentText("team,name\n2052,KnightKrawler\n5653,Iron Mosquitos\n"),
    ["2052", "KnightKrawler", "5653", "Iron Mosquitos"],
  );
});

test("buildAttachmentContext summarizes uploaded file team entries", () => {
  const context = buildAttachmentContext([
    {
      originalname: "teams.csv",
      mimetype: "text/csv",
      size: 41,
      buffer: Buffer.from("team\n2052\nIron Mosquitos\n5653\n"),
    },
  ]);

  assert.equal(context.fileCount, 1);
  assert.equal(context.files[0].name, "teams.csv");
  assert.deepEqual(context.teamQueries, ["2052", "Iron Mosquitos", "5653"]);
  assert.match(context.combinedText, /File: teams.csv/);
});

test("extractEventTeamDirectory parses team name and location", () => {
  const html = `
    <a class="list-group-item list-group-item-action" href="/2026/team/7028">
      <div class="row align-items-center mt-2 mb-2">
        <div class="col-3 col-md-1 fw-bold">7028</div>
        <div class="col-6">Binary Battalion</div>
        <div class="col-3 d-none d-md-block">
          <span>Saint Michael, Minnesota, USA</span>
        </div>
      </div>
    </a>
  `;

  const directory = extractEventTeamDirectory(html);

  assert.deepEqual(directory.get("7028"), {
    number: "7028",
    name: "Binary Battalion",
    location: "Saint Michael, Minnesota, USA",
    avatarUrl: "/team-avatar-fallback.svg",
    firstTeamUrl: "https://frc-events.firstinspires.org/2026/team/7028",
    blueAllianceUrl: "https://www.thebluealliance.com/team/7028",
  });
});

test("extractStandingsStatusMessage reads the pre-event rankings warning", () => {
  const html = `
    <div class="alert alert-warning">
      This event is scheduled to begin Wednesday, April 29, 2026. Please return after the start of Qualification Matches for ranking data.
    </div>
  `;

  assert.match(extractStandingsStatusMessage(html), /April 29, 2026/);
});

test("extractChampionshipStandingsRowsFromHtml parses a populated ranking row", () => {
  const html = `
    <table>
      <tbody>
        <tr>
          <td class="align-middle"><h4>1</h4></td>
          <td>
            <div class="row text-sm-center">
              <div class="col-3"><img src="/img/2491.png" width="40" height="40"></div>
              <div class="col-9 text-center text-lg-start align-middle">
                <div class="fw-bold"><a href="/2026/team/2491">2491</a></div>
                <div class="d-none d-md-block">NoMythic</div>
              </div>
            </div>
          </td>
          <td><span title="Total RP: 34">3.78</span></td>
          <td>265.00</td>
          <td>34.33</td>
          <td>3.89</td>
          <td>8 - 1 - 0</td>
          <td><div class="fw-bold"><a href="/2026/MNMI/qualifications?team=2491">9</a></div></td>
        </tr>
      </tbody>
    </table>
  `;
  const teamDirectory = new Map([
    [
      "2491",
      {
        teamNumber: "2491",
        teamName: "NoMythic",
        location: "Minneapolis, Minnesota, USA",
        avatarUrl: "/img/2491.png",
        firstTeamUrl: "https://frc-events.firstinspires.org/2026/team/2491",
        blueAllianceUrl: "https://www.thebluealliance.com/team/2491",
      },
    ],
  ]);

  const rows = extractChampionshipStandingsRowsFromHtml(html, teamDirectory);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    rank: 1,
    teamNumber: "2491",
    teamName: "NoMythic",
    location: "Minneapolis, Minnesota, USA",
    avatarUrl: "/img/2491.png",
    firstTeamUrl: "https://frc-events.firstinspires.org/2026/team/2491",
    blueAllianceUrl: "https://www.thebluealliance.com/team/2491",
    rankingScore: 3.78,
    matchScore: 265,
    autoFuel: 34.33,
    tower: 3.89,
    record: "8 - 1 - 0",
    matchesPlayed: 9,
  });
});

test("extractTeamEventMatchRows parses team-filtered event rows into partners and opponents", () => {
  const html = `
    <table id="matches">
      <tbody>
        <tr>
          <td><a href="/2026/MNST/qualifications/1">Qualification 1</a></td>
          <td>Sat 5/16 - 8:36 AM</td>
          <td><a href="/2026/team/3276">3276</a></td>
          <td><a href="/2026/team/7797">7797</a></td>
          <td><a href="/2026/team/3100">3100</a></td>
          <td><a href="/2026/team/2472">2472</a></td>
          <td><a href="/2026/team/2846">2846</a></td>
          <td><b><a href="/2026/team/7028">7028</a></b></td>
          <td>329</td>
          <td>396</td>
        </tr>
      </tbody>
    </table>
  `;

  const parsed = extractTeamEventMatchRows(html, "7028", "qualification");

  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0], {
    id: "qualification-1",
    stage: "qualification",
    matchLabel: "Qualification 1",
    startTimeLabel: "Sat 5/16 - 8:36 AM",
    redTeamNumbers: ["3276", "7797", "3100"],
    blueTeamNumbers: ["2472", "2846", "7028"],
    allianceColor: "blue",
    partnerTeamNumbers: ["2472", "2846"],
    opponentTeamNumbers: ["3276", "7797", "3100"],
    redScore: 329,
    blueScore: 396,
    targetTeamScore: 396,
    opponentScore: 329,
    matchUrl: "https://frc-events.firstinspires.org/2026/MNST/qualifications/1",
  });
});

test("summarizeHistoryEntry keeps the past-questions list small and useful", () => {
  const summary = summarizeHistoryEntry({
    id: "abc123",
    createdAt: "2026-04-16T12:00:00.000Z",
    question: "Highest autonomous score in Minnesota FRC events in 2026",
    answer: "Highest autonomous score found: 113 points.",
    supported: true,
    intent: "highest_auto_score",
    result: {
      highestAutoScore: 113,
      eventName: "Minnesota Granite City Regional",
      matchName: "Playoff Final 2",
    },
  });

  assert.deepEqual(summary, {
    id: "abc123",
    createdAt: "2026-04-16T12:00:00.000Z",
    question: "Highest autonomous score in Minnesota FRC events in 2026",
    attachments: [],
    answer: "Highest autonomous score found: 113 points.",
    supported: true,
    intent: "highest_auto_score",
    highestAutoScore: 113,
    eventName: "Minnesota Granite City Regional",
    matchName: "Playoff Final 2",
  });
});

test("pruneHistoryKeepOldest removes all but the oldest archived question", () => {
  const pruned = pruneHistoryKeepOldest([
    { id: "newest", createdAt: "2026-04-16T12:00:00.000Z" },
    { id: "middle", createdAt: "2026-04-15T12:00:00.000Z" },
    { id: "oldest", createdAt: "2026-04-14T12:00:00.000Z" },
  ]);

  assert.deepEqual(pruned, [{ id: "oldest", createdAt: "2026-04-14T12:00:00.000Z" }]);
});

test("extractMetricQuery removes boilerplate and keeps the scoring term", () => {
  const metricQuery = extractMetricQuery("what is the top tower score in minnesota in 2026?");
  assert.equal(metricQuery, "tower");
});

test("findMatchingScoreLabels matches broad score labels like tower", () => {
  const matches = findMatchingScoreLabels("tower", [
    "Autonomous Points",
    "Auto Tower Points",
    "Endgame Tower Points",
    "Foul Points",
  ]);

  assert.deepEqual(matches, ["Auto Tower Points", "Endgame Tower Points"]);
});

test("extractScoreBreakdown parses official FIRST match score rows", () => {
  const html = `
    <table>
      <tr><td>Auto Tower Points</td><td>0</td><td>0</td></tr>
      <tr><td>Autonomous Points</td><td>79</td><td>113</td></tr>
      <tr><td>Foul Points</td><td>+5</td><td>+25</td></tr>
      <tr><td>Endgame Tower</td><td>None None None</td><td>None None None</td></tr>
    </table>
  `;

  assert.deepEqual(extractScoreBreakdown(html), [
    { label: "Auto Tower Points", blueScore: 0, redScore: 0 },
    { label: "Autonomous Points", blueScore: 79, redScore: 113 },
    { label: "Foul Points", blueScore: 5, redScore: 25 },
  ]);
});

test("buildScoreCategoryAnswer explains ambiguous score-row matches", () => {
  const answer = buildScoreCategoryAnswer({
    metricQuery: "tower",
    highestScore: 12,
    metricLabel: "Endgame Tower Points",
    matchName: "Playoff Final 2",
    eventName: "Minnesota Granite City Regional",
    allianceColor: "red",
    allianceTeams: ["2470", "6045", "7028"],
    matchedLabels: ["Auto Tower Points", "Endgame Tower Points"],
    scannedMatchCount: 554,
    eventCount: 6,
  });

  assert.match(answer, /Highest tower score found: 12 points/);
  assert.match(answer, /Specific score row: Endgame Tower Points/);
  assert.match(answer, /Matched score rows: Auto Tower Points, Endgame Tower Points/);
});

test("extractTeamLookupName pulls the team name out of a natural-language query", () => {
  assert.equal(
    extractTeamLookupName("what is the team number for the Iron Mosquitos?"),
    "Iron Mosquitos",
  );
});

test("extractAllTeamsDirectory parses official team rows", () => {
  const html = `
    <a class="list-group-item list-group-item-action" href="/2026/team/5653">
      <div class="row align-items-center mt-2 mb-2">
        <div class="col-2 col-md-1">
          <img src="data:image/png;base64,abc123" width="35" height="35" />
        </div>
        <div class="col-3 col-md-1 fw-bold">5653</div>
        <div class="col-6 col-md-4">Iron Mosquitos</div>
        <div class="col-2 d-none d-md-block">Regional</div>
        <div class="col-3 d-none d-md-block">Babbitt, Minnesota, USA</div>
      </div>
    </a>
  `;

  assert.deepEqual(extractAllTeamsDirectory(html), [
    {
      number: "5653",
      name: "Iron Mosquitos",
      districtLabel: "Regional",
      location: "Babbitt, Minnesota, USA",
      avatarUrl: "data:image/png;base64,abc123",
      firstTeamUrl: "https://frc-events.firstinspires.org/2026/team/5653",
      blueAllianceUrl: "https://www.thebluealliance.com/team/5653",
    },
  ]);
});

test("scoreTeamNameMatch strongly prefers an exact team-name match", () => {
  const exact = scoreTeamNameMatch("Iron Mosquitos", { number: "5653", name: "Iron Mosquitos" });
  const fuzzy = scoreTeamNameMatch("Iron Mosquitos", { number: "876", name: "Thunder Robotics" });

  assert.ok(exact > fuzzy);
});

test("findBestTeamMatches returns the exact team first", () => {
  const matches = findBestTeamMatches("Iron Mosquitos", [
    { number: "876", name: "Thunder Robotics" },
    { number: "5653", name: "Iron Mosquitos" },
    { number: "7565", name: "Mosquito Robotics" },
  ]);

  assert.equal(matches[0].number, "5653");
  assert.equal(matches[0].name, "Iron Mosquitos");
});

test("buildTeamLookupAnswer states the official team number clearly", () => {
  const answer = buildTeamLookupAnswer({
    season: 2026,
    teamNumber: "5653",
    teamName: "Iron Mosquitos",
    location: "Babbitt, Minnesota, USA",
  });

  assert.match(answer, /Iron Mosquitos is FRC Team 5653/);
  assert.match(answer, /Babbitt, Minnesota, USA/);
  assert.match(answer, /official FIRST 2026 all-teams list/);
});

test("extractRegionalPointsTeamQuery recognizes a specific team regional-points question", () => {
  assert.equal(
    extractRegionalPointsTeamQuery("how many regional points does the Iron Mosquitos team have?"),
    "Iron Mosquitos",
  );
});

test("extractFirstChampionshipTeamQuery recognizes a worlds question", () => {
  assert.equal(
    extractFirstChampionshipTeamQuery("is the Iron Mosquitos team going to world's?"),
    "Iron Mosquitos",
  );
});

test("buildTeamRegionalPointsAnswer summarizes one team's official points", () => {
  const answer = buildTeamRegionalPointsAnswer({
    teamName: "Iron Mosquitos",
    teamNumber: "5653",
    totalPoints: 27,
    rank: 148,
    regional1Points: 27,
    regional1EventCode: "MNMI",
    regional2Points: null,
    regional2Projection: 19,
    regional2EventCode: "MNMI2",
    firstChampionshipLabel: "Regional Pool Week 5",
  });

  assert.match(answer, /Iron Mosquitos \(Team 5653\) have 27 regional points/);
  assert.match(answer, /Current rank: #148/);
  assert.match(answer, /First regional: 27 points \(MNMI\)/);
  assert.match(answer, /Second event projection: 19 points \(MNMI2\)/);
  assert.match(answer, /FIRST Championship: Regional Pool Week 5/);
});

test("buildTeamChampionshipAnswer states the current invitation status clearly", () => {
  const answer = buildTeamChampionshipAnswer({
    teamName: "Iron Mosquitos",
    teamNumber: "5653",
    qualifiedFirstCmp: true,
    firstChampionshipLabel: "Direct Qualified at NDGF",
    totalPoints: 120,
    rank: 80,
  });

  assert.match(answer, /are invited to the 2026 FIRST Championship/);
  assert.match(answer, /Status: Direct Qualified at NDGF/);
  assert.match(answer, /Regional points: 120/);
  assert.match(answer, /Regional pool rank: #80/);
});
