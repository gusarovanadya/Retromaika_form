const crypto = require('crypto');

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

function getDbConfig() {
  const keyName = ['SUPABASE', 'SERVICE', 'ROLE', 'KEY'].join('_');
  return {
    url: (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    key: process.env[keyName] || '',
  };
}

async function dbRequest(path, options = {}) {
  const { url, key } = getDbConfig();
  if (!url || !key) {
    const err = new Error('Supabase is not configured');
    err.code = 'SUPABASE_CONFIG';
    throw err;
  }

  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }

  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `Supabase HTTP ${res.status}`);
    err.code = data && data.code;
    err.details = data;
    err.status = res.status;
    throw err;
  }

  return data;
}

function validate(body) {
  const fio    = String(body.fio    || '').trim();
  const index  = String(body.index  || '').trim();
  const city   = String(body.city   || '').trim();
  const street = String(body.street || '').trim();
  const phone  = String(body.phone  || '').trim();
  const email  = String(body.email  || '').trim();
  const amount = Number(body.amount);

  if (fio.split(/\s+/).filter(Boolean).length < 2)      return 'Некорректное ФИО';
  if (!/^\d{6}$/.test(index))                            return 'Некорректный индекс';
  if (city.length < 2 || street.length < 3)              return 'Некорректный адрес';
  if (phone.replace(/\D/g, '').length !== 11)             return 'Некорректный телефон';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))         return 'Некорректный email';
  if (!body.offerAccepted || !body.privacyAccepted)       return 'Согласия не подтверждены';
  if (!amount || amount <= 0 || !Number.isFinite(amount)) return 'Некорректная сумма';
  return null;
}

function makeTbankToken(params, secretKey) {
  const filtered = Object.assign({}, params, { Password: secretKey });
  delete filtered.Token;
  delete filtered.Receipt;
  delete filtered.DATA;

  const sortedKeys = Object.keys(filtered).sort();
  const str = sortedKeys.map(k => String(filtered[k])).join('');
  return crypto.createHash('sha256').update(str).digest('hex');
}

async function createTbankPayment({
  terminalKey, secretKey,
  amount, orderId, description,
  successUrl, failUrl, notificationUrl,
  email, taxation, paymentMethod, paymentObject, tax,
  customerData,
}) {
  const amountKopecks = Math.round(amount * 100);

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

  params.Receipt = {
    Email:    email,
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

    if (!terminalKey || !secretKey) {
      console.error(JSON.stringify({ level: 'error', stage: 'config', requestId, message: 'Missing T-Bank env vars' }));
      return json(500, { error: 'Ошибка конфигурации платёжного сервиса', requestId });
    }

    const orderId = requestId.slice(0, 36);
    const { fio, index, city, street, room = '', phone, email, amount } = body;
    const amountKopecks = Math.round(Number(amount) * 100);

    console.log(JSON.stringify({
      level: 'info', stage: 'config', requestId, orderId, amountKopecks,
      hasTerminalKey: !!terminalKey, hasSecretKey: !!secretKey,
      taxation, tax, paymentMethod, paymentObject,
    }));

    try {
      await dbRequest('orders', {
        method: 'POST',
        body: JSON.stringify({
          order_id:   orderId,
          fio,
          phone,
          email,
          index,
          city,
          street,
          room,
          amount:     Number(amount),
          created_at: new Date().toISOString(),
          status:     'pending',
        }),
      });
    } catch (dbError) {
      console.error(JSON.stringify({
        level: 'error', stage: 'db-save', requestId, orderId,
        message: dbError.message, code: dbError.code || '', status: dbError.status || '', details: dbError.details || undefined,
      }));
      return json(500, { error: 'Ошибка сохранения заказа', requestId });
    }

    console.log(JSON.stringify({ level: 'info', stage: 'db-save', requestId, orderId }));

    let paymentUrl;
    try {
      paymentUrl = await createTbankPayment({
        terminalKey,
        secretKey,
        amount,
        orderId,
        description: `Заказ @retromaika — ${fio}`,
        successUrl,
        failUrl,
        notificationUrl,
        email,
        taxation,
        paymentMethod,
        paymentObject,
        tax,
        customerData: { fio, phone, email, index, city, street, room },
      });
    } catch (tbankError) {
      try {
        await dbRequest(`orders?order_id=eq.${encodeURIComponent(orderId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'payment_init_failed' }),
        });
      } catch (updateErr) {
        console.error(JSON.stringify({ level: 'error', stage: 'db-update-init-failed', requestId, orderId, message: updateErr.message }));
      }
      throw tbankError;
    }

    console.log(JSON.stringify({ level: 'info', stage: 'create-payment', requestId, orderId, idempotencyKey, amountKopecks, city, status: 'ok' }));

    return json(200, { ok: true, requestId, redirectUrl: paymentUrl });

  } catch (error) {
    console.error(JSON.stringify({
      level: 'error', stage: 'exception', requestId, message: error.message,
      tbankErrorCode: error.tbankErrorCode || undefined,
      tbankMessage:   error.tbankMessage   || undefined,
      tbankDetails:   error.tbankDetails   || undefined,
      httpStatus:     error.httpStatus     || undefined,
      stack:          error.stack,
    }));
    return json(500, { error: 'Внутренняя ошибка сервера', requestId });
  }
};
