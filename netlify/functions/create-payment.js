// netlify/functions/create-payment.js
//
// Required env vars (Netlify → Site settings → Environment variables):
//   TBANK_TERMINAL_KEY       — TerminalKey from T-Bank merchant portal
//   TBANK_SECRET_KEY         — SecretKey (password) from T-Bank merchant portal
//   TBANK_SUCCESS_URL        — e.g. https://retromaikaform.netlify.app/success.html
//   TBANK_FAIL_URL           — e.g. https://retromaikaform.netlify.app/fail.html
//   TBANK_NOTIFICATION_URL   — e.g. https://retromaikaform.netlify.app/.netlify/functions/tbank-webhook
//
// Optional env vars (receipt / Telegram):
//   TBANK_TAXATION           — default "usn_income"
//   TBANK_TAX                — default "none"
//   TBANK_PAYMENT_METHOD     — default "full_prepayment"
//   TBANK_PAYMENT_OBJECT     — default "commodity"
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID

const crypto = require('crypto');

// ── Вспомогательная функция ответа ───────────────────────────
function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

// ── Транслитерация (ГОСТ 7.79-2000, система Б) ───────────────
function translit(str) {
  const map = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z',
    'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
    'с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh',
    'щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
    'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'Yo','Ж':'Zh','З':'Z',
    'И':'I','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R',
    'С':'S','Т':'T','У':'U','Ф':'F','Х':'Kh','Ц':'Ts','Ч':'Ch','Ш':'Sh',
    'Щ':'Sch','Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya',
  };
  return String(str || '').split('').map(c => (map[c] !== undefined ? map[c] : c)).join('');
}

// ── Словарь официальных английских названий городов ──────────
const CITY_EN = {
  'москва': 'Moscow',
  'санкт-петербург': 'Saint Petersburg',
  'санкт петербург': 'Saint Petersburg',
  'петербург': 'Saint Petersburg',
  'питер': 'Saint Petersburg',
  'новосибирск': 'Novosibirsk',
  'екатеринбург': 'Yekaterinburg',
  'казань': 'Kazan',
  'нижний новгород': 'Nizhny Novgorod',
  'челябинск': 'Chelyabinsk',
  'самара': 'Samara',
  'уфа': 'Ufa',
  'ростов-на-дону': 'Rostov-on-Don',
  'ростов на дону': 'Rostov-on-Don',
  'омск': 'Omsk',
  'красноярск': 'Krasnoyarsk',
  'воронеж': 'Voronezh',
  'пермь': 'Perm',
  'волгоград': 'Volgograd',
  'краснодар': 'Krasnodar',
  'саратов': 'Saratov',
  'тюмень': 'Tyumen',
  'тольятти': 'Tolyatti',
  'ижевск': 'Izhevsk',
  'барнаул': 'Barnaul',
  'ульяновск': 'Ulyanovsk',
  'иркутск': 'Irkutsk',
  'хабаровск': 'Khabarovsk',
  'ярославль': 'Yaroslavl',
  'владивосток': 'Vladivostok',
  'махачкала': 'Makhachkala',
  'томск': 'Tomsk',
  'оренбург': 'Orenburg',
  'кемерово': 'Kemerovo',
  'новокузнецк': 'Novokuznetsk',
  'рязань': 'Ryazan',
  'астрахань': 'Astrakhan',
  'пенза': 'Penza',
  'липецк': 'Lipetsk',
  'тула': 'Tula',
  'киров': 'Kirov',
  'чебоксары': 'Cheboksary',
  'калининград': 'Kaliningrad',
  'брянск': 'Bryansk',
  'курск': 'Kursk',
  'иваново': 'Ivanovo',
  'магнитогорск': 'Magnitogorsk',
  'улан-удэ': 'Ulan-Ude',
  'улан удэ': 'Ulan-Ude',
  'сочи': 'Sochi',
  'владимир': 'Vladimir',
  'нижний тагил': 'Nizhny Tagil',
  'белгород': 'Belgorod',
  'ставрополь': 'Stavropol',
  'сургут': 'Surgut',
  'тверь': 'Tver',
  'кострома': 'Kostroma',
  'смоленск': 'Smolensk',
  'чита': 'Chita',
  'калуга': 'Kaluga',
  'якутск': 'Yakutsk',
  'волжский': 'Volzhsky',
  'орёл': 'Oryol',
  'орел': 'Oryol',
  'мурманск': 'Murmansk',
  'архангельск': 'Arkhangelsk',
  'тамбов': 'Tambov',
  'нальчик': 'Nalchik',
  'грозный': 'Grozny',
  'петрозаводск': 'Petrozavodsk',
  'череповец': 'Cherepovets',
  'вологда': 'Vologda',
  'владикавказ': 'Vladikavkaz',
  'серпухов': 'Serpukhov',
  'курган': 'Kurgan',
  'псков': 'Pskov',
  'великий новгород': 'Veliky Novgorod',
  'нижневартовск': 'Nizhnevartovsk',
  'йошкар-ола': 'Yoshkar-Ola',
  'йошкар ола': 'Yoshkar-Ola',
  'саранск': 'Saransk',
  'стерлитамак': 'Sterlitamak',
  'балашиха': 'Balashikha',
  'химки': 'Khimki',
  'подольск': 'Podolsk',
  'волгодонск': 'Volgodonsk',
  'таганрог': 'Taganrog',
  'комсомольск-на-амуре': 'Komsomolsk-on-Amur',
  'нефтекамск': 'Neftekamsk',
  'новороссийск': 'Novorossiysk',
  'пятигорск': 'Pyatigorsk',
  'люберцы': 'Lyubertsy',
  'мытищи': 'Mytishchi',
};

function capitalizeWords(str) {
  return String(str || '').replace(/\b([a-zA-Z])([a-zA-Z]*)/g, (_, f, r) => f.toUpperCase() + r);
}

function cityToEn(city) {
  const key = String(city || '').trim().toLowerCase();
  return CITY_EN[key] || capitalizeWords(translit(city));
}

// ── Очистка адреса от сокращений ─────────────────────────────
function cleanAddressForEn(str) {
  const prefixes = [
    'улица','ул','шоссе','ш','проспект','пр-т','пр','переулок','пер',
    'набережная','наб','площадь','пл','бульвар','б-р','бул','тупик','туп',
    'проезд','пр-д','микрорайон','мкр','м-н','аллея','ал','линия','лин',
    'владение','вл','дом','д','корпус','корп','к','строение','стр',
  ].sort((a, b) => b.length - a.length);

  let result = String(str || '');
  prefixes.forEach(p => {
    const re = new RegExp('(^|\\s)' + p.replace(/[-]/g, '\\-') + '\\.?(?=\\s|$)', 'gi');
    result = result.replace(re, '$1');
  });
  return result
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.\-]+|[\s,.\-]+$/g, '')
    .trim();
}

function cleanRoomForEn(str) {
  const prefixes = [
    'квартира','кв','помещение','пом','офис','оф','комната','ком','апартаменты','апарт',
  ].sort((a, b) => b.length - a.length);

  let result = String(str || '');
  prefixes.forEach(p => {
    const re = new RegExp('(^|\\s)' + p + '\\.?(?=\\s|$)', 'gi');
    result = result.replace(re, '$1');
  });
  return result.replace(/\s+/g, ' ').trim();
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
// Алгоритм: все верхнеуровневые параметры кроме Token, Receipt, DATA,
// добавить Password, отсортировать по ключу, склеить значения, SHA-256
function makeTbankToken(params, secretKey) {
  const filtered = Object.assign({}, params, { Password: secretKey });
  delete filtered.Token;
  delete filtered.Receipt;
  delete filtered.DATA;

  const sortedKeys = Object.keys(filtered).sort();
  const str = sortedKeys.map(k => String(filtered[k])).join('');
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ── Отправка в Telegram ───────────────────────────────────────
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

// ── Создание платежа в Т-банке (ФФД 1.05) ────────────────────
async function createTbankPayment({
  terminalKey, secretKey,
  amount, orderId, description,
  successUrl, failUrl, notificationUrl,
  phone, taxation, paymentMethod, paymentObject, tax,
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

  // Receipt добавляем ПОСЛЕ расчёта подписи — не входит в Token
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
    const botToken        = process.env.TELEGRAM_BOT_TOKEN;
    const chatId          = process.env.TELEGRAM_CHAT_ID;

    // OrderId: UUID из заголовка, до 36 символов
    const orderId = requestId.slice(0, 36);

    const { fio, index, city, street, room = '', phone, amount } = body;
    const amountKopecks = Math.round(Number(amount) * 100);

    console.log(JSON.stringify({
      level:              'info',
      stage:              'config',
      requestId,
      orderId,
      amountKopecks,
      hasTerminalKey:     !!terminalKey,
      hasSecretKey:       !!secretKey,
      hasTelegramBotToken: !!botToken,
      hasTelegramChatId:  !!chatId,
      taxation,
      tax,
      paymentMethod,
      paymentObject,
    }));

    if (!terminalKey || !secretKey) {
      console.error(JSON.stringify({ level: 'error', stage: 'config', requestId, message: 'Missing T-Bank env vars' }));
      return json(500, { error: 'Ошибка конфигурации платёжного сервиса', requestId });
    }

    // Создаём платёж в Т-банке
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
    });

    // Telegram-уведомление — необязательно, не блокирует оплату
    if (botToken && chatId) {
      const roomLineRu = room ? `\nКвартира: ${room}` : '';
      const msgRu = [
        'Новый заказ @retromaika',
        '',
        `ФИО: ${fio}`,
        `Телефон: ${phone}`,
        `Индекс: ${index}`,
        `Город: ${city}`,
        `Адрес: ${street}${roomLineRu}`,
        `Сумма: ${Number(amount).toLocaleString('ru-RU')} ₽`,
        '',
        `orderId: ${orderId}`,
        `requestId: ${requestId}`,
        idempotencyKey ? `idempotencyKey: ${idempotencyKey}` : null,
      ].filter(x => x !== null).join('\n');

      const streetEn    = capitalizeWords(translit(cleanAddressForEn(street)));
      const cityEn      = cityToEn(city);
      const nameEn      = translit(fio);
      const msgEnLines  = [
        `Name: ${nameEn}`,
        `Post code: ${index}`,
        'Country: Russia',
        `City: ${cityEn}`,
        `Street: ${streetEn}`,
      ];
      if (room) msgEnLines.push(`Room: ${translit(cleanRoomForEn(room))}`);
      msgEnLines.push(`Phone number: ${cleanPhone(phone)}`);
      const msgEn = msgEnLines.join('\n');

      try {
        await sendTelegram(botToken, chatId, msgRu);
        await sendTelegram(botToken, chatId, msgEn);
      } catch (tgErr) {
        console.error(JSON.stringify({
          level: 'error', stage: 'telegram',
          requestId, message: tgErr.message,
        }));
      }
    } else {
      console.log(JSON.stringify({
        level: 'info', stage: 'telegram', requestId,
        message: 'Telegram not configured, skipping',
      }));
    }

    console.log(JSON.stringify({
      level: 'info', stage: 'create-payment',
      requestId, orderId, idempotencyKey, amountKopecks, city, status: 'ok',
    }));

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
