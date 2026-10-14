const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
try {
  const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }

async function main() {
  const provider = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'openai')).toLowerCase();
  const key = provider === 'gemini' ? (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY) : process.env.OPENAI_API_KEY;
  if (!key) { console.error(`No API key is configured for ${provider} in .env or the environment.`); process.exitCode = 1; return; }
  const model = provider === 'gemini' ? (process.env.GEMINI_MODEL || 'gemini-3.6-flash') : (process.env.OPENAI_MODEL || 'gpt-4o-mini');
  const endpoint = provider === 'gemini'
    ? 'https://generativelanguage.googleapis.com/v1beta/models'
    : (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions');
  try {
    const response = await fetch(endpoint, {
      method: provider === 'gemini' ? 'GET' : 'POST',
      headers: { ...(provider === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` }), 'Content-Type': 'application/json' },
      ...(provider === 'gemini' ? {} : { body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'Reply with OK.' }] }) })
    });
    const raw = await response.text();
    let body = {}; try { body = JSON.parse(raw); } catch {}
    if (response.ok) {
      if (provider === 'gemini') {
        const available = (body.models || []).filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => m.name?.replace(/^models\//, '')).filter(Boolean);
        if (available.includes(model)) console.log(`Gemini API key works. ${model} is available for content generation.`);
        else console.log(`Gemini API key works, but ${model} is not in this key’s available model list. Choose a listed model in .env.`);
      } else {
        const answer = body.choices?.[0]?.message?.content?.trim();
        console.log(`OpenAI API key works. Model responded: ${answer || 'response received'}.`);
        console.log(`Model: ${body.model || model}`);
      }
    } else {
      const code = body.error?.code || '';
      const detail = response.status === 401 || /invalid_api_key|api_key_invalid/i.test(code)
        ? `The ${provider === 'gemini' ? 'Gemini' : 'OpenAI'} API key was rejected. Check that .env contains a current key for this provider and that it was copied completely.`
        : String(body.error?.message || raw || 'No error details returned.').replace(/\s+/g, ' ').replace(/\b(?:sk|AQ)[A-Za-z0-9._-]{8,}\b/g, '[redacted key]').slice(0, 420);
      console.error(`API check failed (${response.status}${code ? `, ${code}` : ''}): ${detail}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Could not reach the API: ${error.message}`);
    process.exitCode = 1;
  }
}
main();
