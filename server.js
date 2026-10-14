const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const pdfParse = require('pdf-parse');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
// Load local secrets on the server only. Existing process environment values take precedence.
try {
  const envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const PORT = Number(process.env.PORT || 3000);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

const sessions = new Map();
const emptyWorkspace = () => ({ notes: [], sets: [], attempts: [] });
function readData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!data.users) data.users = [];
    if (!data.workspaces) {
      // Preserve existing single-user demo data for the first account created.
      data.legacyWorkspace = { notes: data.notes || [], sets: data.sets || [], attempts: data.attempts || [] };
      data.workspaces = {};
      delete data.notes; delete data.sets; delete data.attempts;
    }
    return data;
  } catch { return { users: [], workspaces: {} }; }
}
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
function cookieValue(req, name) {
  return (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
}
function currentUser(req) { const token = cookieValue(req, 'studybuddy_session'); return token ? sessions.get(token) : null; }
function setSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, user.id);
  res.setHeader('Set-Cookie', `studybuddy_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
}
function userWorkspace(data, userId) { return data.workspaces[userId] || (data.workspaces[userId] = emptyWorkspace()); }
function safeUser(user) { return { id: user.id, name: user.name, email: user.email }; }
function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve({ salt, hash: key.toString('hex') })));
}
function passwordMatches(password, user) {
  return new Promise((resolve, reject) => crypto.scrypt(password, user.salt, 64, (err, key) => {
    if (err) return reject(err);
    const stored = Buffer.from(user.passwordHash, 'hex');
    resolve(stored.length === key.length && crypto.timingSafeEqual(stored, key));
  }));
}
function cleanPdfText(text) {
  return text.replace(/\r/g, '\n').replace(/[•]/g, '\n- ')
    .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([)\]])(?=\d+[A-Z])/g, '$1 ').replace(/([a-zA-Z])([=+×])/g, '$1 $2').replace(/([=+×])([a-zA-Z])/g, '$1 $2')
    .split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(line => line && !/^\d{1,3}$/.test(line)).join('\n');
}
function aiProvider() {
  return (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'openai')).toLowerCase();
}
function aiKey() {
  return aiProvider() === 'gemini' ? (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY) : process.env.OPENAI_API_KEY;
}
function send(res, status, value, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 18_000_000) reject(new Error('File is too large. Please upload a PDF smaller than 12 MB.')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function makeDemoSet(note) {
  const stop = new Set('about after again also among because before being between could does during each from have into more most other over same some such than that their them then there these they this through under until very what when where which while with would your'.split(' '));
  const sentences = note.content.replace(/\r/g, '\n').split(/\n+/).flatMap(line => line.split(/(?<=[.!?])\s+/)).map(s => s.replace(/^[-•*]\s*/, '').trim()).filter(s => s.split(/\s+/).length >= 7 && s.length <= 420);
  const sourceSentences = sentences.length ? sentences : [note.content.trim()];
  const words = text => (text.match(/[A-Za-z][A-Za-z'-]{4,}/g) || []).filter(w => !stop.has(w.toLowerCase()));
  const terms = [...new Set(sourceSentences.flatMap(words).map(w => w.replace(/['-]$/, '')))].filter(w => w.length >= 5);
  const cards = sourceSentences.slice(0, 8).map(sentence => {
    const key = words(sentence)[0];
    return { front: key ? `What do your notes say about “${key}”?` : 'Explain this key idea in your own words.', back: sentence };
  });
  const questionSources = sourceSentences.filter(s => words(s).length).slice(0, 5);
  const questions = questionSources.map((sentence, i) => {
    const candidates = words(sentence).sort((a,b) => b.length - a.length);
    const answerTerm = candidates.find(w => !/^(therefore|however|between|through|systematic)$/i.test(w)) || candidates[0];
    const distractors = [...new Set(terms.filter(t => t.toLowerCase() !== answerTerm.toLowerCase() && !sentence.toLowerCase().includes(t.toLowerCase())))].slice(0, 3);
    while (distractors.length < 3) distractors.push(['example', 'process', 'evidence'][distractors.length]);
    const options = [...distractors, answerTerm];
    const answer = (i * 3 + 1) % options.length;
    const rotated = options.slice(answer).concat(options.slice(0, answer));
    const masked = sentence.replace(new RegExp('\\b' + answerTerm + '\\b', 'i'), '_____');
    return { prompt: `Complete the idea from your notes: “${masked}”`, options: rotated, answer, explanation: sentence, source: sentence };
  });
  const summary = sourceSentences.slice(0, 3).map(s => s.length > 170 ? `${s.slice(0, 167).trimEnd()}…` : s).join(' ');
  return { title: note.title || 'Your study set', summary: summary || 'Review the key ideas from your notes.', cards, questions, provider: 'demo' };
}

async function generateSet(note) {
  const provider = aiProvider();
  const key = aiKey();
  if (!key) return makeDemoSet(note);
  const model = provider === 'gemini' ? (process.env.GEMINI_MODEL || 'gemini-3.6-flash') : (process.env.OPENAI_MODEL || 'gpt-4o-mini');
  const systemPrompt = 'You are a careful tutor. Use only the supplied notes; never add outside facts. Create a concise accurate study set. Return JSON with title, summary (2-3 clear sentences, no truncation), cards (5-8 useful question/answer pairs), and questions (exactly 5 multiple-choice questions). Each question must test a distinct important idea; use a clear question, four concise plausible options, answer as the zero-based integer index of the correct option, a brief explanation, and source as an exact supporting quote from the notes. Distractors must be plausible but clearly contradicted by the notes. Vary correct answer positions. If notes do not support five distinct questions, create fewer rather than repeat or invent. Avoid vague prompts such as “Which statement is correct?”';
  const userPrompt = `Subject: ${note.subject}\nTitle: ${note.title}\nNotes:\n${note.content}`;
  const response = provider === 'gemini'
    ? await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents: [{ role: 'user', parts: [{ text: userPrompt }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } })
    })
    : await fetch(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
    });
  if (!response.ok) {
    const raw = await response.text();
    let apiError = {};
    try { apiError = JSON.parse(raw).error || {}; } catch { apiError.message = raw; }
    const code = apiError.code || apiError.status || apiError.type || '';
    const detail = response.status === 401 || /invalid_api_key/i.test(code)
      ? `The ${provider === 'gemini' ? 'Gemini' : 'OpenAI'} API key was rejected. Check that .env contains a current key for the selected provider and that it was copied completely.`
      : String(apiError.message || 'No error details were returned.').replace(/\s+/g, ' ').replace(/\b(?:sk|AQ)[A-Za-z0-9._-]{8,}\b/g, '[redacted key]').slice(0, 420);
    const retryAfter = response.headers.get('retry-after');
    let help = '';
    if (response.status === 429 && /insufficient_quota|credit_balance_exhausted|spend_limit|usage_limit/i.test(code)) help = ' Check API credits and project or organization spend limits.';
    else if (response.status === 429) help = retryAfter ? ` Retry after ${retryAfter} seconds.` : ' Wait briefly, then try again.';
    throw new Error(`${provider === 'gemini' ? 'Gemini' : 'OpenAI'} API ${response.status}${code ? ` (${code})` : ''}: ${detail}${help}`);
  }
  const result = await response.json();
  const content = provider === 'gemini' ? result.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') : result.choices?.[0]?.message?.content;
  const output = JSON.parse(content || '{}');
  if (!Array.isArray(output.cards) || !Array.isArray(output.questions) || !output.questions.length || output.questions.some(q => !q.prompt || !Array.isArray(q.options) || q.options.length !== 4 || !Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3 || !q.explanation || !q.source)) throw new Error('AI returned an incomplete study set');
  return { ...output, provider };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const { name = '', email = '', password = '' } = await readBody(req);
      const normalizedEmail = String(email).trim().toLowerCase();
      if (String(name).trim().length < 2) return send(res, 400, { error: 'Enter a name with at least 2 characters.' });
      if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) return send(res, 400, { error: 'Enter a valid email address.' });
      if (String(password).length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      const data = readData();
      if (data.users.some(user => user.email === normalizedEmail)) return send(res, 409, { error: 'An account with this email already exists.' });
      const credentials = await passwordHash(password);
      const user = { id: crypto.randomUUID(), name: String(name).trim().slice(0, 80), email: normalizedEmail, ...credentials, createdAt: new Date().toISOString() };
      data.users.push(user);
      data.workspaces[user.id] = data.legacyWorkspace || emptyWorkspace();
      delete data.legacyWorkspace;
      saveData(data); setSession(res, user);
      return send(res, 201, { user: safeUser(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const { email = '', password = '' } = await readBody(req);
      const data = readData(); const user = data.users.find(u => u.email === String(email).trim().toLowerCase());
      if (!user || !(await passwordMatches(String(password), user))) return send(res, 401, { error: 'Email or password is incorrect.' });
      setSession(res, user); return send(res, 200, { user: safeUser(user) });
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      const userId = currentUser(req); const user = readData().users.find(u => u.id === userId);
      if (!user) return send(res, 401, { error: 'Please sign in to continue.' });
      return send(res, 200, { user: safeUser(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = cookieValue(req, 'studybuddy_session'); if (token) sessions.delete(token);
      res.setHeader('Set-Cookie', 'studybuddy_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return send(res, 200, { ok: true });
    }
    const userId = currentUser(req);
    if (url.pathname.startsWith('/api/') && !userId) return send(res, 401, { error: 'Please sign in to continue.' });
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const data = readData(); return send(res, 200, { user: safeUser(data.users.find(u => u.id === userId)), ...userWorkspace(data, userId), aiEnabled: Boolean(aiKey()), aiProvider: aiProvider() });
    }
    if (req.method === 'POST' && url.pathname === '/api/notes') {
      const { title = '', subject = '', content = '', pdfBase64 = '', pdfName = '' } = await readBody(req);
      let extracted = content.trim();
      if (pdfBase64) {
        const buffer = Buffer.from(pdfBase64, 'base64');
        if (buffer.subarray(0, 5).toString() !== '%PDF-') return send(res, 400, { error: 'That file does not look like a valid PDF.' });
        try { extracted = [extracted, cleanPdfText((await pdfParse(buffer)).text).trim()].filter(Boolean).join('\n\n'); }
        catch { return send(res, 400, { error: 'We could not read that PDF. Try another file or paste the text instead.' }); }
        if (!extracted) return send(res, 400, { error: 'This PDF has no selectable text. Scanned PDFs need OCR; paste the text instead.' });
      }
      if (!extracted) return send(res, 400, { error: 'Add some notes or choose a PDF first.' });
      const titleValue = title.trim() || (pdfName ? path.parse(pdfName).name : 'Untitled notes');
      const subjectValue = subject.trim() || 'General';
      const existing = userWorkspace(readData(), userId).notes.find(n => n.title === titleValue && n.subject === subjectValue && n.content === extracted);
      if (existing) return send(res, 200, existing);
      const data = readData(); const workspace = userWorkspace(data, userId); const note = { id: crypto.randomUUID(), title: title.trim() || (pdfName ? path.parse(pdfName).name : 'Untitled notes'), subject: subject.trim() || 'General', content: extracted, sourceFile: pdfName || null, createdAt: new Date().toISOString() };
      workspace.notes.unshift(note); saveData(data); return send(res, 201, note);
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/notes/') && url.pathname.endsWith('/generate')) {
      const id = url.pathname.split('/')[3]; const data = readData(); const workspace = userWorkspace(data, userId); const note = workspace.notes.find(n => n.id === id);
      if (!note) return send(res, 404, { error: 'Note not found.' });
      if (note.sourceFile) note.content = cleanPdfText(note.content);
      const studySet = await generateSet(note);
      if (!studySet.questions.length) return send(res, 400, { error: 'There is not enough readable content to make useful questions. Add more notes or upload a text-based PDF.' });
      studySet.id = crypto.randomUUID(); studySet.noteId = id; studySet.subject = note.subject; studySet.createdAt = new Date().toISOString();
      workspace.sets.unshift(studySet); saveData(data); return send(res, 201, studySet);
    }
    if (req.method === 'POST' && url.pathname === '/api/attempts') {
      const body = await readBody(req); const data = readData(); const workspace = userWorkspace(data, userId); const set = workspace.sets.find(s => s.id === body.setId);
      if (!set) return send(res, 404, { error: 'Study set not found.' });
      const score = set.questions.reduce((n, q, i) => n + (Number(body.answers?.[i]) === q.answer ? 1 : 0), 0);
      const attempt = { id: crypto.randomUUID(), setId: set.id, score, total: set.questions.length, createdAt: new Date().toISOString() };
      workspace.attempts.unshift(attempt); saveData(data); return send(res, 201, attempt);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/define/')) {
      const word = decodeURIComponent(url.pathname.slice('/api/define/'.length));
      const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      if (!response.ok) return send(res, 404, { error: 'No definition found.' });
      const json = await response.json(); const meaning = json[0]?.meanings?.[0];
      return send(res, 200, { word: json[0]?.word || word, partOfSpeech: meaning?.partOfSpeech || '', definition: meaning?.definitions?.[0]?.definition || '' });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
    const file = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^[/\\]+/, '');
    const full = path.resolve(ROOT, 'public', file);
    if (!full.startsWith(path.resolve(ROOT, 'public') + path.sep)) return send(res, 403, { error: 'Forbidden.' });
    fs.readFile(full, (err, contents) => err ? send(res, 404, 'Not found.', 'text/plain; charset=utf-8') : send(res, 200, contents, MIME[path.extname(full)] || 'application/octet-stream'));
  } catch (error) { send(res, 500, { error: error.message || 'Something went wrong.' }); }
});

server.listen(PORT, () => console.log(`StudyBuddy is running at http://localhost:${PORT}`));
