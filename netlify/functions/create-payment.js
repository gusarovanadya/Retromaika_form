// netlify/functions/create-payment.js
//
// Required env vars (Netlify → Site settings → Environment variables):
//   TBANK_TERMINAL_KEY       — TerminalKey from T-Bank merchant portal
//   TBANK_SECRET_KEY         — SecretKey (password) from T-Bank merchant portal
//   TBANK_SUCCESS_URL        — e.g. https://retromaikaform.netlify.app/success.html
//   TBANK_FAIL_URL           — e.g. https://retromaikaform.netlify.app/fail.html
//   TBANK_NOTIFICATION_URL   — e.g. https://retromaikaform.netlify.app/.netlify/functions/tbank-webhook
//
// Optional env vars (receipt):
//   TBANK_TAXATION        — default "usn_income"
//   TBANK_TAX             — default "none"
//   TBANK_PAYMENT_METHOD  — default "full_prepayment"
//   TBANK_PAYMENT_OBJECT  — default "commodity"

const crypto      = require('crypto');
const { getStore } = require('@netlify/blobs');

// ── Вспомогательная функция ответа ───────────────────────────
function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function cleanPhone(phone) {
  return '+' + String(phone || '').replace(/\D/g, '');
}

// ── Серверная валидация ───────────────────────────────────────
function validate(body) {
  const fio    = String(body.fio    || '').trim();
  const index  = String(body.index  || '').trim();
  const city   = String(body.city   || '').trim();
  const street = String(body.street || '').trim();
  const phone  = String(body.phone  || '').trim();
  const amount = Number(body.amount);

  if (fio.split(/\s+/).filter(Boolean).length < 2) return 'Некорректное ФИО';
  if (!/^\d{6}$/.test(index))                       return 'Некорректный индекс';
  if (city.length < 2 || street.length < 3)         return 'Некорректный адрес';
  if (phone.replace(/\D/g, '').length !== 11)        return 'Некорректный телефон';
  if (!body.offerAccepted || !body.privacyAccepted)  return 'Согласия не подтверждены';
  if (!amount || amount <= 0 || !Number.isFinite(amount)) return 'Некорректная сумма';
  return null;
}

// ── Подпись для Т-банк API (SHA-256) ─────────────────────────
// Все верхнеуровневые параметры кроме Token, Receipt, DATA,
// + Password, отсортировать по ключу, склеить значения, SHA-256
function makeTbankToken(params, secretKey) {
  const filtered = Object.assign({}, params, { Password: secretKey });
  delete filtered.Token;
  delete filtered.Receipt;
  delete filtered.DATA;

  const sortedKeys = Object.keys(filtered).sort();
  const str = sortedKeys.map(k => String(filtered[k])).join('');
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ── Создание платежа в Т-банке (ФФД 1.05) ────────────────────
async function createTbankPayment({
  terminalKey, secretKey,
  amount, orderId, description,
  successUrl, failUrl, notificationUrl,
  phone, taxation, paymentMethod, paymentObject, tax,
  customerData,
}) {
  const amountKopecks = Math.round(amount * 100);

  // Верхнеуровневые параметры — участвуют в подписи
  const params = {
    TerminalKey:     terminalKey,
    Amount:          amountKopecks,
    OrderId:         orderId,
    Description:     description.slice(0, 140),
    PayType:         'O',
    SuccessURL:      successUrl,
    FailURL:         failUrl,
    NotificationURL: notificationUrl,
  };

  params.Token = makeTbankToken(params, secretKey);

  // Receipt и DATA добавляем ПОСЛЕ расчёта подписи — оба не входят в Token
  params.Receipt = {
    Phone:    cleanPhone(phone),
    Taxation: taxation,
    Items: [{
      Name:          'Футбольная атрибутика Retromaika',
      Price:         amountKopecks,
      Quantity:      1,
      Amount:        amountKopecks,
      PaymentMethod: paymentMethod,
      PaymentObject: paymentObject,
      Tax:           tax,
    }],
  };

  params.DATA = customerData;

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 10000);
  try {
    const res  = await fetch('https://securepay.tinkoff.ru/v2/Init', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(params),
      signal:  controller.signal,
    });
    const data = await res.json();
    if (!res.ok || !data.Success) {
      const err = new Error(data.Message || data.Details || `Т-банк HTTP ${res.status}`);
      err.tbankErrorCode = data.ErrorCode;
      err.tbankMessage   = data.Message;
      err.tbankDetails   = data.Details;
      err.httpStatus     = res.status;
      throw err;
    }
    return data.PaymentURL;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Основной обработчик ───────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const requestId      = event.headers['x-request-id']    || ('req_' + Date.now());
  const idempotencyKey = event.headers['idempotency-key'] || '';

  try {
    const body            = JSON.parse(event.body || '{}');
    const validationError = validate(body);
    if (validationError) return json(400, { error: validationError, requestId });

    const terminalKey     = process.env.TBANK_TERMINAL_KEY;
    const secretKey       = process.env.TBANK_SECRET_KEY;
    const successUrl      = process.env.TBANK_SUCCESS_URL      || '';
    const failUrl         = process.env.TBANK_FAIL_URL         || '';
    const notificationUrl = process.env.TBANK_NOTIFICATION_URL || '';
    const taxation        = process.env.TBANK_TAXATION         || 'usn_income';
    const tax             = process.env.TBANK_TAX              || 'none';
    const paymentMethod   = process.env.TBANK_PAYMENT_METHOD   || 'full_prepayment';
    const paymentObject   = process.env.TBANK_PAYMENT_OBJECT   || 'commodity';

    // OrderId: UUID из заголовка запроса, до 36 символов
    const orderId = requestId.slice(0, 36);

    const { fio, index, city, street, room = '', phone, amount } = body;
    const amountKopecks = Math.round(Number(amount) * 100);

    console.log(JSON.stringify({
      level:           'info',
      stage:           'config',
      requestId,
      orderId,
      amountKopecks,
      hasTerminalKey:  !!terminalKey,
      hasSecretKey:    !!secretKey,
      taxation,
      tax,
      paymentMethod,
      paymentObject,
    }));

    if (!terminalKey || !secretKey) {
      console.error(JSON.stringify({
        level: 'error', stage: 'config', requestId,
        message: 'Missing T-Bank env vars',
      }));
      return json(500, { error: 'Ошибка конфигурации платёжного сервиса', requestId });
    }

    // Сохраняем заказ в Netlify Blobs по orderId до вызова Init.
    // tbank-webhook.js прочитает запись по тому же orderId при CONFIRMED.
    try {
      const store = getStore('orders');
      await store.setJSON(orderId, {
        fio, phone, index, city, street, room,
        amount:       Number(amount),
        amountKopecks,
        createdAt:    new Date().toISOString(),
        status:       'pending',
      });
      console.log(JSON.stringify({ level: 'info', stage: 'blob-save', requestId, orderId }));
    } catch (blobErr) {
      // Ненадёжный blob не блокирует оплату — webhook упадёт в fallback
      console.error(JSON.stringify({
        level: 'error', stage: 'blob-save',
        requestId, orderId, message: blobErr.message,
      }));
    }

    // Создаём платёж — Telegram не отправляется здесь
    const paymentUrl = await createTbankPayment({
      terminalKey,
      secretKey,
      amount,
      orderId,
      description: `Заказ @retromaika — ${fio}`,
      successUrl,
      failUrl,
      notificationUrl,
      phone,
      taxation,
      paymentMethod,
      paymentObject,
      tax,
      // Данные заказа передаём через DATA — webhook использует их для Telegram
      customerData: { fio, phone, index, city, street, room },
    });

    console.log(JSON.stringify({
      level: 'info', stage: 'create-payment',
      requestId, orderId, idempotencyKey, amountKopecks, city, status: 'ok',
    }));

    // redirectUrl возвращается клиенту немедленно — до любых Telegram-действий
    return json(200, { ok: true, requestId, redirectUrl: paymentUrl });

  } catch (error) {
    console.error(JSON.stringify({
      level:          'error',
      stage:          'exception',
      requestId,
      message:        error.message,
      tbankErrorCode: error.tbankErrorCode || undefined,
      tbankMessage:   error.tbankMessage   || undefined,
      tbankDetails:   error.tbankDetails   || undefined,
      httpStatus:     error.httpStatus     || undefined,
      stack:          error.stack,
    }));
    return json(500, { error: 'Внутренняя ошибка сервера', requestId });
  }
};
