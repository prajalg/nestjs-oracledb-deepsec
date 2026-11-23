'use strict';

// Extraction only. The application's guard must authenticate/authorize the request.
function mapBearerIdentity(request) {
  const authorization = request.headers?.authorization;
  const match = typeof authorization === 'string' && /^Bearer\s+(\S+)$/i.exec(authorization);
  return match ? { endUserToken: match[1] } : null;
}

// For built-in Azure login without passportSession. Read only server-side session data.
// Passport apps should map their authenticated request.user (or CLS user) instead.
function mapSessionIdentity(request) {
  const identity = request.session?.identity;
  if (!identity || !Number.isFinite(identity.expiresAt) || identity.expiresAt <= Date.now() ||
      typeof identity.token !== 'string' || !identity.token.trim()) return null;
  return { endUserToken: identity.token };
}

module.exports = { mapBearerIdentity, mapSessionIdentity };
