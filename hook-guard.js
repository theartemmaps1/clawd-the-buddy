'use strict';
// Checks for the hook server. Claude Code's hooks come from a local program; a web page in
// your browser can also reach 127.0.0.1, so requests that look like a browser's are refused.

// Returns an HTTP status to refuse the request with, or 0 to let it through.
function check(req, port) {
  const h = req.headers;
  // DNS rebinding: a hostile page can point its own name at 127.0.0.1, but the Host header
  // still carries that name. A hook always says the address it was given.
  const host = String(h.host || '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 403;
  // Browsers attach Origin to cross-origin POSTs (even "simple" ones with no preflight).
  // Claude Code, curl and scripts do not.
  if (h.origin !== undefined) return 403;
  // A browser form or text/plain post can't be told apart by size alone, so a body that
  // declares itself as something other than JSON is turned away as well. No header is fine.
  if (req.method === 'POST' && h['content-type'] !== undefined && !/^application\/json\s*(;|$)/i.test(h['content-type'])) return 415;
  return 0;
}

// Sets a key in a map that has to stay small: session ids come from the sender, so without a
// cap a stream of made-up ids would grow the map for ever. The oldest entry makes way.
function remember(map, key, value, max) {
  map.delete(key); // re-insert so a live session counts as newest
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

module.exports = { check, remember };
