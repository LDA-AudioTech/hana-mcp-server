#!/usr/bin/env node

/**
 * HANA MCP Server — HTTP transport with LDA per-request auth support.
 *
 * Forked from hana-mcp-server v0.3.1 src/server/http-index.js.
 *
 * ── LDA Custom ──
 * Adds support for X-HANA-User / X-HANA-Password headers that create
 * ephemeral HANA connections per-request instead of using the env-var pool.
 *
 * Preserve this file when upgrading hana-mcp-server.
 */

const http = require('http');
const { AsyncLocalStorage } = require('async_hooks');
const { logger } = require('../utils/logger');
const MCPHandler = require('./mcp-handler');
const { ERROR_CODES } = require('../constants/mcp-constants');
const { validateBearer } = require('./http-auth');
const { redactSecrets } = require('../utils/sensitive-redact');
const { isOriginAllowed } = require('./http-origin');
const { connectionManager } = require('../database/connection-manager');
const { createHanaClient } = require('../database/hana-client');

// ── LDA Custom ────────────────────────────────────────────────────
// Per-request HANA credentials context (REQ-HPAU-04, REQ-HPAU-05)
// Uses AsyncLocalStorage so concurrent requests don't race.
const hanaCredsStorage = new AsyncLocalStorage();

// Monkey-patch connectionManager.withConnection to support ephemeral
// per-request connections when per-user credentials are in context.
// The config-like object passed to createHanaClient is compatible with
// its internal buildLegacyConnectionParams() fallback path.
const originalWithConnection = connectionManager.withConnection.bind(connectionManager);
connectionManager.withConnection = async function wrappedWithConnection(fn) {
  const perUserCreds = hanaCredsStorage.getStore();
  if (perUserCreds) {
    const conn = await createHanaClient({
      host:     process.env.HANA_HOST,
      port:     process.env.HANA_PORT || '443',
      user:     perUserCreds.user,
      password: perUserCreds.password,
      encrypt:  process.env.HANA_ENCRYPT !== 'false',
      validateCert: process.env.HANA_VALIDATE_CERT !== 'false',
      databaseName: process.env.HANA_DATABASE_NAME,
      ssl:      process.env.HANA_SSL !== 'false',
    });
    try {
      return await fn(conn);
    } finally {
      try { await conn.disconnect(); } catch (_) { /* ignore close errors */ }
    }
  }
  return originalWithConnection(fn);
};

function getPerUserCreds(req) {
  const user     = req.headers['x-hana-user'];
  const password = req.headers['x-hana-password'];

  if (!user && !password) return null;
  if (!user || !password) {
    const err = new Error('Both X-HANA-User and X-HANA-Password are required');
    err.statusCode = 400;
    err.jsonRpcError = { code: -32602, message: 'Both X-HANA-User and X-HANA-Password are required' };
    throw err;
  }
  return { user, password };
}
// ── End LDA Custom ────────────────────────────────────────────────

const PORT = parseInt(process.env.MCP_HTTP_PORT, 10) || 3100;
const HOST = process.env.MCP_HTTP_HOST || '127.0.0.1';
const MCP_PATH = '/mcp';

function sendResponse(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function sendJsonRpcError(res, id, code, message) {
  const safe = redactSecrets(message != null ? String(message) : '');
  sendResponse(res, 200, {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message: safe }
  });
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin, process.env.MCP_HTTP_ALLOWED_ORIGINS)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Origin' } }));
    return;
  }

  const path = (req.url || '').split('?')[0];
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'hana-mcp-server' }));
    return;
  }

  if (path !== MCP_PATH && !req.url.startsWith(`${MCP_PATH}?`)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found', path: MCP_PATH }));
    return;
  }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      server: 'hana-mcp-server',
      transport: 'Streamable HTTP',
      message: 'Send JSON-RPC requests via POST to this URL',
      mcpPath: MCP_PATH
    }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'GET, POST' });
    res.end();
    return;
  }

  // ── LDA Custom ──
  // Check for per-request HANA credentials BEFORE JWT auth (they are
  // orthogonal — JWT protects the MCP endpoint, per-user creds are for HANA).
  let perUserCreds = null;
  try {
    perUserCreds = getPerUserCreds(req);
  } catch (err) {
    const status = err.statusCode || 400;
    const body = err.jsonRpcError
      ? { jsonrpc: '2.0', error: err.jsonRpcError, id: null }
      : { jsonrpc: '2.0', error: { code: -32602, message: err.message }, id: null };
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  // ── End LDA Custom ──

  if (process.env.MCP_HTTP_AUTH_ENABLED === 'true') {
    try {
      await validateBearer(req);
    } catch (err) {
      const status = err.statusCode || 401;
      const headers = { 'Content-Type': 'application/json' };
      if (err.wwwAuth) headers['WWW-Authenticate'] = err.wwwAuth;
      res.writeHead(status, headers);
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32600, message: redactSecrets(err.message) }
        })
      );
      return;
    }
  }

  const protocolVersion = req.headers['mcp-protocol-version'] || '2025-11-25';

  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }

  let request;
  try {
    request = JSON.parse(body || '{}');
  } catch (_) {
    sendJsonRpcError(res, null, ERROR_CODES.PARSE_ERROR, 'Parse error');
    return;
  }

  const validation = MCPHandler.validateRequest(request);
  if (!validation.valid) {
    sendJsonRpcError(res, request.id, ERROR_CODES.INVALID_REQUEST, validation.error);
    return;
  }

  // ── LDA Custom ──
  // Wrap request processing in AsyncLocalStorage context so the
  // monkey-patched connectionManager.withConnection picks up per-user creds.
  const processRequest = async () => {
    try {
      const response = await MCPHandler.handleRequest(request);
      if (response) {
        sendResponse(res, 200, response);
      } else {
        res.writeHead(202);
        res.end();
      }
    } catch (err) {
      logger.error(`HTTP MCP error: ${redactSecrets(err.message)}`);
      sendJsonRpcError(res, request.id, ERROR_CODES.INTERNAL_ERROR, redactSecrets(err.message));
    }
  };

  if (perUserCreds) {
    hanaCredsStorage.run(perUserCreds, processRequest);
  } else {
    await processRequest();
  }
  // ── End LDA Custom ──
});

server.listen(PORT, HOST, () => {
  logger.info(`MCP HTTP server listening on http://${HOST}:${PORT}${MCP_PATH}`);
});

server.on('error', (err) => {
  logger.error(`HTTP server error: ${redactSecrets(err.message)}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});