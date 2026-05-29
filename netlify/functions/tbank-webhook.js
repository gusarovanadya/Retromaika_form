// netlify/functions/tbank-webhook.js
//
// Receives payment status notifications from T-Bank.
// Telegram is sent ONLY when Status === "CONFIRMED" and Success === true.
// T-Bank expects HTTP 200 with body "OK" — always returned, even on auth failure.
//
// Required env vars:
//   TBANK_SECRET_KEY     — used to verify the notification Token
//
// Optional env vars:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID

const crypto = require('crypto');

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

// ── Подпись T-Bank (SHA-256) ──────────────────────────────────
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

// ── Основной обработчик ───────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    // Malformed body — still return 200 so T-Bank stops retrying
    return { statusCode: 200, body: 'OK' };
  }

  const secretKey = process.env.TBANK_SECRET_KEY;
  const botToken  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId    = process.env.TELEGRAM_CHAT_ID;

  // ── Проверка подписи ──────────────────────────────────────
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

  // DATA может прийти как объект (штатно) или как строка (защитный разбор)
  let customerData = {};
  if (data.DATA) {
    customerData = typeof data.DATA === 'string'
      ? (() => { try { return JSON.parse(data.DATA); } catch { return {}; } })()
      : data.DATA;
  }

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

  // ── Telegram только на CONFIRMED ─────────────────────────
  const isConfirmed = (Success === true || Success === 'true') && Status === 'CONFIRMED';

  if (isConfirmed && botToken && chatId) {
    const { fio, phone, index, city, street, room } = customerData;
    const amountRub = Number(Amount) / 100;

    let msgRu, msgEn;

    if (fio && phone && index && city && street) {
      // ── Русский блок (1:1 с исходным форматом, без технических ID) ──
      const roomLineRu = room ? `\nКвартира: ${room}` : '';
      msgRu = [
        'Новый заказ @retromaika',
        '',
        `ФИО: ${fio}`,
        `Телефон: ${phone}`,
        `Индекс: ${index}`,
        `Город: ${city}`,
        `Адрес: ${street}${roomLineRu}`,
        `Сумма: ${amountRub.toLocaleString('ru-RU')} ₽`,
      ].join('\n');

      // ── Английский блок (1:1 с исходным форматом) ──────────────────
      const streetEn   = capitalizeWords(translit(cleanAddressForEn(street)));
      const cityEn     = cityToEn(city);
      const nameEn     = translit(fio);
      const msgEnLines = [
        `Name: ${nameEn}`,
        `Post code: ${index}`,
        'Country: Russia',
        `City: ${cityEn}`,
        `Street: ${streetEn}`,
      ];
      if (room) msgEnLines.push(`Room: ${translit(cleanRoomForEn(room))}`);
      msgEnLines.push(`Phone number: ${cleanPhone(phone)}`);
      msgEn = msgEnLines.join('\n');
    } else {
      // DATA не пришёл или неполный — минимальный fallback
      msgRu = [
        '✅ Оплата прошла @retromaika',
        '',
        `Сумма: ${amountRub.toLocaleString('ru-RU')} ₽`,
      ].join('\n');
      msgEn = null;
    }

    try {
      await sendTelegram(botToken, chatId, msgRu);
      if (msgEn) await sendTelegram(botToken, chatId, msgEn);
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
