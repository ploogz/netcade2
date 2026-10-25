'use strict';
/**
 * Reads a lobby code and (optionally) a server address out of an invite:
 * a netcade://join/CODE?s=URL link, or a whole invite message pasted from a chat app.
 */
const CODE_CHARS = 'A-HJ-NP-Z2-9'; // the server never uses 0, O, 1 or I

function parseInvite(text) {
  const str = String(text || '');
  let code = '';
  let server = '';
  const link = /netcade:\/\/join\/([A-Za-z0-9]{4,8})(?:\?s=([^\s]+))?/i.exec(str);
  if (link) {
    code = link[1];
    if (link[2]) { try { server = decodeURIComponent(link[2]); } catch { /* ignore */ } }
  }
  // "Code: ABC123" (no word boundaries: chat apps and single-line boxes can squash lines together)
  if (!code) code = (/code\s*[:\-]\s*([A-Za-z0-9]{6})/i.exec(str) || /\bcode\s+([A-Za-z0-9]{6})\b/i.exec(str) || [])[1] || '';
  if (!code) code = (new RegExp(`(?:^|[^A-Za-z0-9])([${CODE_CHARS}]{6})(?![A-Za-z0-9])`).exec(str.toUpperCase().trim().length === 6 ? str.toUpperCase().trim() : str) || [])[1] || '';
  if (!server) server = (/(https?:\/\/[^\s"'<>)\]]+)/i.exec(str) || [])[1] || '';
  // squashed lines: "https://x.trycloudflare.comCopy this whole message" -> cut at the next sentence
  server = server.replace(/(Copy|Paste|Join|Open|Then)$/, '');
  server = server.replace(/[.,;!?]+$/, '').replace(/\/+$/, '');
  if (server && !/^https?:\/\/[^/]+/i.test(server)) server = '';
  return { code: code.toUpperCase(), server };
}

module.exports = { parseInvite };
