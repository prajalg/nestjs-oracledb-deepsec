'use strict';

// Serialize messages only, never provider response/configuration objects or stacks.
function redact(message) {
  for (const [key, value] of Object.entries(process.env)) {
    if (/password|credential|secret|token|connectionstring/i.test(key) && value) {
      message = message.split(value).join('[REDACTED]');
    }
  }
  return message
    .replace(/\(DESCRIPTION\s*=[\s\S]*/gi, '[REDACTED connection descriptor]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED token]')
    .replace(/\b((?:client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|password|credential|assertion)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi, '$1[REDACTED]')
    .slice(0, 4000);
}
function errorDetails(error, fallback = 'Request failed') {
  const messages = [];
  const seen = new Set();
  let code;
  for (let current = error; current && !seen.has(current) && seen.size < 5; current = current.cause) {
    seen.add(current);
    const candidate = current.code || current.errorCode;
    if (!code && typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(candidate)) code = candidate;
    if (typeof current.message === 'string' && current.message.trim()) messages.push(current.message);
    if (Array.isArray(current.errorCodes)) {
      for (const number of current.errorCodes) {
        if (Number.isSafeInteger(number) && number > 0) messages.push(`AADSTS${number}`);
      }
    }
  }
  return { ...(code && { code }), message: redact([...new Set(messages)].join('\nCaused by: ') || fallback) };
}
module.exports = { errorDetails };
