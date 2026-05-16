# FIRST Data Query MVP

Small Node app that answers one natural-language query shape by scraping public FIRST Robotics Competition event pages:
Now upgraded to use OpenAI GPT-5.4 with tool-assisted research over official/public FIRST Robotics sources.

## Run

```bash
npm install
cp .env.example .env.local
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

## Notes

- Configure `OPENAI_API_KEY` in `.env.local` or the environment before starting the app.
- The app uses GPT-5.4 with a research loop that can inspect FIRST, The Blue Alliance, and Statbotics pages.
- The deterministic Minnesota 2026 autonomous-score computation remains available to the model as a tool.
