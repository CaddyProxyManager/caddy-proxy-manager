/**
 * Stands in for Authelia at "mock-forward-auth:9091". /api/authz/forward-auth answers like it:
 * 200 with Remote-* headers, 302 for a browser, 401 otherwise. /api/always-redirect always 302s,
 * the case where turning the redirect into a 401 is CPM's job.
 */
const http = require('node:http');

const PORT = 9091;
const PORTAL_URL = 'http://auth-portal.test:9091/';
const VALID_COOKIE = 'authelia_session=valid-session';

function identityHeaders() {
  return {
    'Remote-User': 'alice',
    'Remote-Groups': 'admins,users',
    'Remote-Email': 'alice@example.com',
    'Remote-Name': 'Alice Example',
    'Remote-IP': '10.0.0.1',
  };
}

function isBrowserRequest(req) {
  const accept = req.headers.accept || '';
  const requestedWith = req.headers['x-requested-with'] || '';
  return accept.includes('text/html') && requestedWith.length === 0;
}

function redirectTarget(req) {
  const original = `http://${req.headers['x-forwarded-host'] || 'unknown'}${req.headers['x-forwarded-uri'] || '/'}`;
  return `${PORTAL_URL}?rd=${encodeURIComponent(original)}`;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body || '');
}

function handleAuth(req, res, mode) {
  if ((req.headers.cookie || '').includes(VALID_COOKIE)) {
    send(res, 200, identityHeaders());
    return;
  }
  if (mode === 'always-redirect' || isBrowserRequest(req)) {
    send(res, 302, { Location: redirectTarget(req) }, 'Redirecting to portal');
    return;
  }
  send(
    res,
    401,
    { 'Content-Type': 'application/json' },
    JSON.stringify({ status: '401', message: 'Unauthenticated' }),
  );
}

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/api/authz/forward-auth') {
    handleAuth(req, res, 'authelia');
    return;
  }
  if (path === '/api/always-redirect') {
    handleAuth(req, res, 'always-redirect');
    return;
  }
  if (path === '/health') {
    send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ status: 'ok' }));
    return;
  }
  send(res, 404, {}, 'not found');
});

server.listen(PORT, () => {
  console.log(`mock-forward-auth listening on :${PORT}`);
});
