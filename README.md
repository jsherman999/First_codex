# Codex FIRST MVP

Node/Express app for querying public FIRST Robotics data with a mix of deterministic data routes and GPT-5.4 tool-assisted research.

## What It Does

The app can answer and render structured results for:

- Minnesota 2026 highest autonomous score and other match-page score categories
- 2026 EPA rankings, including Minnesota-filtered EPA
- FIRST regional-points standings and team regional profiles
- FIRST Championship division rosters, EPA rankings, and standings
- Minnesota State High School League Championship (`MNST`) live rankings with EPA added
- Team-specific event matchup tables showing partners and opponents with EPA, match by match
- Team lookup by name
- Attached-file team lists sorted by EPA

When there is no dedicated deterministic route, the app can fall back to GPT-5.4 with tool calls across:

- official FIRST event/team pages
- official FRC Events API
- The Blue Alliance
- Statbotics

## UI Features

- Debug panel showing current source / processing step
- LLM trace panel showing prompt, tool calls, and final payload
- Past-question archive with reload and clear controls
- Team links, icons, and hover metadata in rendered tables
- File upload support for text, CSV, TSV, JSON, Markdown, and log files

## Run

```bash
npm install
cp .env.example .env.local
npm start
```

Then open [http://localhost:3000](http://localhost:3000), or use another port:

```bash
PORT=3100 npm start
```

## Environment

Set these in `.env.local` or the shell environment:

```bash
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=gpt-5.4
```

## Test

```bash
npm test
```

## Notes

- The app caches FIRST and Statbotics responses in-memory for faster repeat queries.
- Team icon / directory snapshots and query history are stored under `data/`.
- Some event-specific routes use official FIRST off-season pages when those pages expose useful live tables that are not otherwise normalized by a dedicated app route.
