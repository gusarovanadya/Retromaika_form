// netlify/functions/tbank-webhook.js
//
// Receives payment status notifications from T-Bank.
// T-Bank expects HTTP 200 with body "OK" on success.
//
// Required env vars:
//   TBANK_SECRET_KEY     — used to verify the notification Token
//
// Optional env vars:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID

const crypto = require('crypto');

function makeTbankToken(params, secretKey) {
  const filtered = Object.assign({}, params, { Password: secretKey });
  delete filtered.Token;
  delete filtered.Receipt;
  delete filtered.DATA;

  const sortedKeys = Object.keys(filtered).sort();
  const str = sortedKeys.map(k => String(filtered[k])).join('');
  return crypto.createHash('sha256').update(str).digest('hex');
}

async function sendTelegram(botToken, chatId, text) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 8000);
  try {
    const res  = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text }),
      signal:  controller.signal,
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.description || `Telegram HTTP ${res.status}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Bad Request' };
  }

  const secretKey = process.env.TBANK_SECRET_KEY;
  const botToken  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId    = process.env.TELEGRAM_CHAT_ID;

  // Verify notification token — reject silently but still return 200
  // (T-Bank retries on non-200; responding 200 stops retries even on bad token)
  if (secretKey && data.Token) {
    const expected = makeTbankToken(data, secretKey);
    if (expected !== data.Token) {
      console.error(JSON.stringify({
        level:   'error',
        stage:   'webhook-auth',
        orderId: data.OrderId,
        status:  data.Status,
        message: 'Token mismatch — possible spoofed notification',
      }));
      return { statusCode: 200, body: 'OK' };
    }
  }

  const { Status, OrderId, PaymentId, Amount, Pan, ErrorCode, Success } = data;

  console.log(JSON.stringify({
    level:     'info',
    stage:     'webhook',
    orderId:   OrderId,
    paymentId: PaymentId,
    status:    Status,
    success:   Success,
    amount:    Amount,
    pan:       Pan,
    errorCode: ErrorCode,
  }));

  if (botToken && chatId) {
    const ok  = Success === true || Success === 'true';
    const icon = ok ? '✅' : '❌';
    const lines = [
      `${icon} Оплата ${ok ? 'прошла' : 'не прошла'} — @retromaika`,
      `OrderId: ${OrderId}`,
      `PaymentId: ${PaymentId}`,
      `Статус: ${Status}`,
      Amount  ? `Сумма: ${(Number(Amount) / 100).toLocaleString('ru-RU')} ₽` : null,
      Pan     ? `Карта: ${Pan}` : null,
      !ok && ErrorCode ? `Код ошибки: ${ErrorCode}` : null,
    ].filter(Boolean).join('\n');

    try {
      await sendTelegram(botToken, chatId, lines);
    } catch (err) {
      console.error(JSON.stringify({
        level:   'error',
        stage:   'webhook-telegram',
        orderId: OrderId,
        message: err.message,
      }));
    }
  }

  return { statusCode: 200, body: 'OK' };
};
