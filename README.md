# StudyBuddy

A full-stack study assistant that turns class notes and selectable-text PDFs into quizzes and flashcards. It uses Node.js built-in HTTP and file storage, plus `pdf-parse` for PDF text extraction.

Users can register and sign in with an email and password. Passwords are stored as salted hashes, and each account has its own notes, study sets, and quiz attempts. Accounts and study data are stored locally in `data.json`; this starter app does not include email verification, password reset, or a production database. Sessions are held in server memory and end when the server restarts.

## Run locally

1. Install Node.js 20 or newer.
2. Run `npm install` in this folder.
3. Run `npm start` in this folder.
3. Open [http://localhost:3000](http://localhost:3000).

Study sets work in demo mode until you configure an API key. To enable Gemini, set these values in the local `.env` file:

```powershell
AI_PROVIDER=gemini
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3.6-flash
```

Save `.env` and restart the server. The key stays on the server and is never sent to the browser. `.env` is git-ignored. The app also supports OpenAI chat completions with `AI_PROVIDER=openai`, `OPENAI_API_KEY`, and `OPENAI_MODEL`. When Gemini is selected, `GEMINI_API_KEY` is preferred; `OPENAI_API_KEY` is accepted as a compatibility fallback if that is where the existing key was saved.

The optional dictionary lookup endpoint uses the free Dictionary API (`GET /api/define/:word`). Scanned image-only PDFs need OCR and are not supported yet. The study guide and flashcards currently provide the main learning flow; definitions are exposed through the API for the next UI iteration.

## API

- `GET /api/state` — saved notes, study sets, quiz attempts, and AI availability.
- `POST /api/notes` — save a note (`title`, `subject`, `content`).
- `POST /api/notes/:id/generate` — generate a study set from a saved note.
- `POST /api/attempts` — record and score quiz answers.
- `GET /api/define/:word` — look up a dictionary definition.

Run `npm run check:ai` to send one minimal request to the configured provider and verify API access without printing the key.

Data persists to `data.json`, which is intentionally git-ignored. This is a portfolio starter; production deployment should replace JSON-file persistence with PostgreSQL, add authentication, and use managed file storage for uploaded materials.
