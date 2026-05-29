const form        = document.getElementById('orderForm');
const payBtn      = document.getElementById('payBtn');
const formStatus  = document.getElementById('formStatus');
const check1      = document.getElementById('check1');
const check2      = document.getElementById('check2');
const toast       = document.getElementById('toast');
const amountDisplay = document.getElementById('amountDisplay');

const STORAGE_KEY = 'retromaika_order_form_v2';

const boxes = {
  fio:    document.getElementById('box-fio'),
  index:  document.getElementById('box-index'),
  city:   document.getElementById('box-city'),
  street: document.getElementById('box-street'),
  room:   document.getElementById('box-room'),
  phone:  document.getElementById('box-phone'),
};

let submitInProgress = false;

// ── Сумма из URL (?amount=3500) ──────────────────────────────
function getAmountFromUrl() {
  const raw = new URLSearchParams(window.location.search).get('amount');
  const n = parseInt(raw, 10);
  return (!isNaN(n) && n > 0) ? n : null;
}

const orderAmount = getAmountFromUrl();

// Показываем сумму на кнопке
(function initAmountUI() {
  if (!orderAmount) return;
  const label = document.querySelector('.btn-pay .btn-label');
  if (label) {
    label.innerHTML =
      'Оплатить ' + orderAmount.toLocaleString('ru-RU') + '\u00a0₽' +
      '<div class="arrow"><svg viewBox="0 0 10 10"><path d="M2 5h6M5 2l3 3-3 3"/></svg></div>';
  }
  if (amountDisplay) {
    amountDisplay.textContent = 'Сумма к оплате: ' + orderAmount.toLocaleString('ru-RU') + '\u00a0₽';
    amountDisplay.style.display = 'block';
  }
})();

// ── UI helpers ───────────────────────────────────────────────
function setStatus(message, type) {
  formStatus.textContent = message || '';
  formStatus.className = 'form-status';
  if (type) formStatus.classList.add(type);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

function updatePayBtn() {
  if (submitInProgress) return;
  payBtn.disabled = !(check1.checked && check2.checked);
}

function setLoading(isLoading) {
  submitInProgress = isLoading;
  payBtn.disabled = isLoading || !(check1.checked && check2.checked);
  payBtn.classList.toggle('loading', isLoading);
  payBtn.setAttribute('aria-busy', isLoading ? 'true' : 'false');
}

function markInvalid(id, invalid) {
  if (boxes[id]) boxes[id].classList.toggle('invalid', invalid);
}

// ── localStorage ─────────────────────────────────────────────
function saveFormData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      fio:    document.getElementById('fio').value,
      index:  document.getElementById('index').value,
      city:   document.getElementById('city').value,
      street: document.getElementById('street').value,
      room:   document.getElementById('room').value,
      phone:  document.getElementById('phone').value,
      check1: check1.checked,
      check2: check2.checked,
    }));
  } catch(e) {}
}

function loadFormData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    ['fio', 'index', 'city', 'street', 'room', 'phone'].forEach(id => {
      if (typeof data[id] === 'string') document.getElementById(id).value = data[id];
    });
    check1.checked = !!data.check1;
    check2.checked = !!data.check2;
  } catch(e) {}
}

// ── Форматирование ввода ──────────────────────────────────────
document.getElementById('phone').addEventListener('input', function(e) {
  let val = e.target.value.replace(/\D/g, '');
  if (val.startsWith('7') || val.startsWith('8')) val = val.slice(1);
  val = val.slice(0, 10);
  let res = '+7';
  if (val.length > 0) res += ' (' + val.slice(0, 3);
  if (val.length >= 4) res += ') ' + val.slice(3, 6);
  if (val.length >= 7) res += '-' + val.slice(6, 8);
  if (val.length >= 9) res += '-' + val.slice(8, 10);
  e.target.value = res;
  markInvalid('phone', false);
  saveFormData();
});

document.getElementById('index').addEventListener('input', function(e) {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  markInvalid('index', false);
  saveFormData();
});

['fio', 'city', 'street', 'room'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => { markInvalid(id, false); saveFormData(); });
});

[check1, check2].forEach(cb => {
  cb.addEventListener('change', () => { updatePayBtn(); saveFormData(); });
});

// ── Валидация ─────────────────────────────────────────────────
function validateForm() {
  const rules = {
    fio:    v => v.trim().split(/\s+/).filter(Boolean).length >= 2,
    index:  v => /^\d{6}$/.test(v.trim()),
    city:   v => v.trim().length >= 2,
    street: v => v.trim().length >= 3,
    phone:  v => v.replace(/\D/g, '').length >= 11,
  };

  let valid = true;
  Object.entries(rules).forEach(([id, fn]) => {
    const ok = fn(document.getElementById(id).value);
    markInvalid(id, !ok);
    if (!ok) valid = false;
  });

  if (!check1.checked || !check2.checked) {
    setStatus('Нужно принять оферту и согласие на обработку данных.', 'error');
    return false;
  }
  if (!valid) {
    setStatus('Проверьте заполнение полей формы.', 'error');
    return false;
  }
  setStatus('');
  return true;
}

// ── UUID ──────────────────────────────────────────────────────
function makeUUID() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'req_' + Date.now() + '_' + Math.random().toString(16).slice(2);
}

// ── fetch с таймаутом ─────────────────────────────────────────
async function postJSON(url, payload, extraHeaders) {
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
      body: JSON.stringify(payload),
      signal: controller.signal,
      credentials: 'same-origin',
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch(e) {}
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    return data;
  } catch(err) {
    if (err.name === 'AbortError') throw new Error('Превышено время ожидания. Проверьте интернет.');
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Submit ────────────────────────────────────────────────────
form.addEventListener('submit', async function(e) {
  e.preventDefault();
  if (submitInProgress) return;
  if (!validateForm()) return;

  if (!orderAmount) {
    setStatus('Сумма не указана. Попросите продавца прислать правильную ссылку.', 'error');
    return;
  }

  const requestId      = makeUUID();
  const idempotencyKey = makeUUID();

  setLoading(true);
  setStatus('Подготавливаем оплату...', 'success');
  console.info('[checkout] submit-start', { requestId, idempotencyKey, amount: orderAmount });

  const payload = {
    fio:             document.getElementById('fio').value.trim(),
    index:           document.getElementById('index').value.trim(),
    city:            document.getElementById('city').value.trim(),
    street:          document.getElementById('street').value.trim(),
    room:            document.getElementById('room').value.trim(),
    phone:           document.getElementById('phone').value.trim(),
    amount:          orderAmount,
    offerAccepted:   check1.checked,
    privacyAccepted: check2.checked,
  };

  try {
    const result = await postJSON('/.netlify/functions/create-payment', payload, {
      'X-Request-Id':    requestId,
      'Idempotency-Key': idempotencyKey,
    });

    if (!result.redirectUrl) throw new Error('Сервер не вернул ссылку на оплату');

    try {
      sessionStorage.setItem('lastOrderRequestId', requestId);
      sessionStorage.setItem('lastOrderIdempotencyKey', idempotencyKey);
    } catch(e) {}

    window.location.assign(result.redirectUrl);

  } catch(err) {
    console.error('[checkout] submit-failed', { requestId, error: err.message });
    setStatus(
      'Не удалось перейти к оплате. Попробуйте ещё раз. (код: ' + requestId.slice(0, 8) + ')',
      'error'
    );
    showToast(err.message || 'Ошибка оплаты. Попробуйте ещё раз.');
    setLoading(false);
  }
});

// ── Инициализация ─────────────────────────────────────────────
loadFormData();
updatePayBtn();
