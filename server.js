const http = require('http');
const crypto = require('crypto');

// Configuration according to candidate task specs
const SEED_TOKEN = process.env.PINHIRE_SEED || 'SEED-5095-PH-7C8E';
const HMAC_HEADER = 'x-pinhire-hmac-5095';
const MAX_REFUND_AED = 320;
const IDEMPOTENCY_TTL_MS = 90 * 1000; // 90 seconds
const PORT = process.env.PORT || 3000;

// In-memory idempotency store: tx_ref -> { timestamp }
const idempotencyStore = new Map();

// Periodic cleanup of expired idempotency keys
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of idempotencyStore.entries()) {
    if (now - record.timestamp > IDEMPOTENCY_TTL_MS) {
      idempotencyStore.delete(key);
    }
  }
}, 15000);

// In-memory FAQ cache for sub-millisecond responses
const faqCache = new Map();

const defaultFaqResponses = {
  refund: 'Refunds up to 320 AED can be processed within 30 days of purchase.',
  return: 'Items can be returned within 30 days in original packaging.',
  shipping: 'Standard delivery takes 2-4 business days across the UAE.',
  support: 'Support is available 24/7 for all customers.',
  hours: 'Our operating hours are Sunday through Thursday, 9 AM to 6 PM GST.',
  limit: 'The maximum allowed refund limit is 320 AED.'
};

for (const [k, v] of Object.entries(defaultFaqResponses)) {
  faqCache.set(k, v);
}

/**
 * Fast FAQ answer resolver
 */
function resolveFaqQuery(queryText) {
  if (!queryText || typeof queryText !== 'string') {
    return 'Our refund limit is 320 AED, and return window is 30 days.';
  }

  const normalized = queryText.toLowerCase().trim();
  if (faqCache.has(normalized)) {
    return faqCache.get(normalized);
  }

  // Keyword matching
  for (const [key, answer] of Object.entries(defaultFaqResponses)) {
    if (normalized.includes(key)) {
      faqCache.set(normalized, answer);
      return answer;
    }
  }

  const fallback = `In response to your query regarding "${queryText}": Our standard policy applies with a 320 AED refund limit and 30-day return window.`;
  faqCache.set(normalized, fallback);
  return fallback;
}

/**
 * Extract query string from request body (supporting both root and payload.{...})
 */
function extractQuery(body) {
  const root = body || {};
  const inner = (typeof root.payload === 'object' && root.payload !== null) ? root.payload : {};

  if (typeof root.payload === 'string') {
    return root.payload;
  }

  return (
    inner.query ||
    inner.question ||
    inner.faq_query ||
    inner.message ||
    inner.text ||
    root.query ||
    root.question ||
    root.faq_query ||
    root.message ||
    ''
  );
}

/**
 * Verify HMAC-SHA256 signature against raw request body
 */
function verifyHmacSignature(rawBody, reqHeaders) {
  const incomingHmac = reqHeaders[HMAC_HEADER.toLowerCase()] || 
                       reqHeaders[HMAC_HEADER] || 
                       reqHeaders['x-signature'];

  if (!incomingHmac || typeof incomingHmac !== 'string') {
    return { valid: false, reason: 'Missing HMAC signature header' };
  }

  let cleanHmac = incomingHmac.trim();
  if (cleanHmac.startsWith('sha256=')) {
    cleanHmac = cleanHmac.slice(7).trim();
  }

  const expectedHmac = crypto
    .createHmac('sha256', SEED_TOKEN)
    .update(rawBody)
    .digest('hex');

  const cleanLower = cleanHmac.toLowerCase();
  const expectedLower = expectedHmac.toLowerCase();

  if (cleanLower.length !== expectedLower.length) {
    return { valid: false, reason: 'HMAC length mismatch' };
  }

  const isValid = crypto.timingSafeEqual(
    Buffer.from(cleanLower, 'utf8'),
    Buffer.from(expectedLower, 'utf8')
  );

  return { valid: isValid, reason: isValid ? 'OK' : 'HMAC digest mismatch' };
}

/**
 * Extract refund amount and detect prompt injection (supporting both root and payload.{...})
 */
function extractRefundDetails(body) {
  const root = body || {};
  const inner = (typeof root.payload === 'object' && root.payload !== null) ? root.payload : {};

  let explicitAmount = null;
  const candidates = [
    inner.refund_aed,
    inner.amount,
    inner.refund_amount,
    inner.amount_aed,
    root.refund_aed,
    root.amount,
    root.refund_amount,
    root.amount_aed
  ];

  for (const c of candidates) {
    if (typeof c === 'number' && !isNaN(c)) {
      explicitAmount = c;
      break;
    } else if (typeof c === 'string' && c.trim() !== '') {
      const parsed = parseFloat(c);
      if (!isNaN(parsed)) {
        explicitAmount = parsed;
        break;
      }
    }
  }

  const messageText = String(
    inner.customer_message || 
    inner.message || 
    inner.reason || 
    inner.text ||
    root.customer_message || 
    root.message || 
    root.reason || 
    ''
  );

  const upperMsg = messageText.toUpperCase();
  const isPromptInjection = 
    upperMsg.includes('SYSTEM OVERRIDE') ||
    upperMsg.includes('IGNORE PREVIOUS') ||
    upperMsg.includes('DISREGARD') ||
    upperMsg.includes('ADMIN OVERRIDE') ||
    upperMsg.includes('FORCE REFUND') ||
    upperMsg.includes('OVERRIDE');

  let amount = explicitAmount;

  if (messageText) {
    const match = messageText.match(/(?:refund|pay|give|amount|limit)?\s*(\d+(?:\.\d+)?)\s*(?:aed|dirhams?|usd|\$)?/i);
    if (match && match[1]) {
      const val = parseFloat(match[1]);
      if (!isNaN(val)) {
        if (amount === null || (isPromptInjection && val > amount) || val > MAX_REFUND_AED) {
          amount = val;
        }
      }
    }
  }

  return {
    amount: amount !== null ? amount : 0,
    isPromptInjection,
    messageText
  };
}

/**
 * Main HTTP server request handler
 */
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${HMAC_HEADER}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health check / GET endpoints
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'webhook-candidate-5095',
      candidate_id: 'PH-2026-5095',
      hmac_header: HMAC_HEADER,
      max_refund_limit_aed: MAX_REFUND_AED,
      uptime: process.uptime()
    }));
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));

  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);

    // 1. HMAC Verification (Header x-pinhire-hmac-5095 = hex HMAC-SHA256 of raw body)
    const hmacCheck = verifyHmacSignature(rawBody, req.headers);
    if (!hmacCheck.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'Unauthorized',
        message: hmacCheck.reason
      }));
    }

    // Parse JSON payload
    let body = {};
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
    }

    // 2. Identify Event Type: "refund.requested" | "faq.query"
    const eventType = String(body.event || body.type || body.action || '').toLowerCase();
    const query = extractQuery(body);
    const isFaq = eventType === 'faq.query' || 
                  eventType.includes('faq') || 
                  (Boolean(query) && !body.refund_aed && !body.amount && (!body.payload || (!body.payload.refund_aed && !body.payload.amount)));

    // Case A: FAQ Query (event: "faq.query")
    if (isFaq) {
      const answer = resolveFaqQuery(query);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'processed',
        answer: answer,
        reply: answer,
        response: answer,
        query: query
      }));
    }

    // Case B: Refund Event (event: "refund.requested" | "refund")
    const inner = (typeof body.payload === 'object' && body.payload !== null) ? body.payload : {};
    const txRef = inner.tx_ref_5095 || body.tx_ref_5095;
    const now = Date.now();

    // 3. Idempotency Lock on payload.tx_ref_5095 (TTL: 90s)
    if (txRef) {
      const existing = idempotencyStore.get(txRef);
      if (existing && (now - existing.timestamp < IDEMPOTENCY_TTL_MS)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          status: 'duplicate'
        }));
      }

      // Synchronously acquire lock immediately
      idempotencyStore.set(txRef, { timestamp: now });
    }

    // 4. Refund Limit & Prompt Injection Protection (Max 320 AED)
    const refundDetails = extractRefundDetails(body);

    if (refundDetails.isPromptInjection || refundDetails.amount > MAX_REFUND_AED) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'rejected',
        error: `Refund exceeds maximum limit of ${MAX_REFUND_AED} AED or violates security policy`,
        refund_aed: MAX_REFUND_AED
      }));
    }

    // Valid refund within limit: first -> { "status": "processed", "refund_aed": ... }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'processed',
      refund_aed: refundDetails.amount,
      amount: refundDetails.amount
    }));
  });

  req.on('error', (err) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Webhook server candidate PH-2026-5095 listening on port ${PORT}`);
    console.log(`HMAC Header: ${HMAC_HEADER}`);
    console.log(`Seed Token: ${SEED_TOKEN}`);
    console.log(`Max Refund: ${MAX_REFUND_AED} AED`);
  });
}

module.exports = server;
