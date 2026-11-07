'use strict';
const byId = id => document.getElementById(id);
const sliders = [
  ['rngRoulette', 'valRoulette', 'rouletteBias'], ['rngSlots', 'valSlots', 'slotsBias'],
  ['rngDice', 'valDice', 'diceBias'], ['rngCards', 'valCards', 'cardsBias'],
  ['rngSpecial', 'valSpecial', 'specialBias']
];
let csrfToken = '';
let sessionVersion = 0;
let expiresAt = 0;
let sessionTimer;
let posterData = '';
let posterDirty = false;
let posterLoading = false;
let posterVersion = 0;
let eventSaving = false;
const MAX_GIF_BYTES = 1100000;

function status(id, message, error = false) {
  const element = byId(id);
  element.textContent = message;
  element.classList.toggle('error', error);
}

function posterPreview(message = '') {
  byId('posterPreviewBox').hidden = !posterData;
  byId('removePosterBtn').hidden = !posterData;
  if (posterData) byId('posterDraftPreview').src = posterData;
  else byId('posterDraftPreview').removeAttribute('src');
  byId('posterMeta').textContent = message || (posterData.startsWith('data:image/gif') ? 'GIF · animacja zachowana' : 'Zdjęcie · podgląd na zegarku');
}

function updateEventButtons() {
  byId('saveEventBtn').disabled = posterLoading || eventSaving;
}

function showLogin(message = '') {
  sessionVersion++;
  clearTimeout(sessionTimer);
  csrfToken = '';
  posterVersion++;
  posterData = '';
  posterDirty = false;
  posterLoading = false;
  eventSaving = false;
  expiresAt = 0;
  byId('adminPanel').hidden = true;
  byId('loginSection').hidden = false;
  byId('sessionNotice').hidden = true;
  byId('adminUser').hidden = true;
  byId('logoutBtn').hidden = true;
  byId('adminPassword').value = '';
  byId('eventForm').reset();
  byId('rngForm').reset();
  renderRng({});
  posterPreview();
  updateEventButtons();
  status('globalStatus', '');
  status('eventStatus', '');
  status('rngStatus', '');
  status('loginStatus', message, Boolean(message));
}

function showPanel(session) {
  sessionVersion++;
  csrfToken = session.csrfToken;
  byId('loginSection').hidden = true;
  byId('adminPanel').hidden = false;
  byId('sessionNotice').hidden = true;
  byId('adminUser').textContent = session.username;
  byId('adminUser').hidden = false;
  byId('logoutBtn').hidden = false;
  byId('adminPassword').value = '';
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => showLogin('Sesja wygasła. Zaloguj się ponownie.'),
    Math.max(0, session.expiresAt - Date.now()));
}

async function request(path, { method = 'GET', body, allowUnauthorized = false } = {}) {
  const version = sessionVersion;
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(path, {
    method, headers, credentials: 'same-origin', cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await response.json().catch(() => ({ error: 'Serwer zwrócił nieprawidłową odpowiedź.' }));
  if (version !== sessionVersion) {
    const error = new Error('Sesja została zmieniona.');
    error.stale = true;
    throw error;
  }
  if (!response.ok) {
    if (response.status === 401 && !allowUnauthorized) showLogin('Sesja wygasła. Zaloguj się ponownie.');
    const error = new Error(json.error || 'Nie udało się wykonać operacji.');
    error.status = response.status;
    throw error;
  }
  return json;
}

function renderRng(rng) {
  for (const [inputId, outputId, key] of sliders) {
    byId(inputId).value = String(rng[key] || 0);
    const value = Number(byId(inputId).value);
    byId(outputId).textContent = value > 0 ? '+' + value : String(value);
  }
}

function renderSummary(event) {
  expiresAt = event.active ? event.expiresAt : 0;
  byId('eventStateLabel').textContent = event.active ? 'AKTYWNE WYDARZENIE' : 'BRAK AKTYWNEGO WYDARZENIA';
  byId('liveEventTitle').textContent = event.active ? event.title : 'Przygotuj kolejne wydarzenie';
  byId('liveEventDesc').textContent = event.active ? event.description : 'Wydarzenie pojawi się na zegarkach po zapisaniu.';
  byId('liveEventDetails').hidden = !event.active;
  byId('liveEventMult').textContent = 'Wygrane ×' + event.winMultiplier;
  byId('liveEventBonus').textContent = 'Bonus ' + event.dailyBonus + ' $';
  byId('clearEventBtn').disabled = !event.active;
  updateCountdown();
}

function renderEvent(event) {
  renderSummary(event);
  byId('evTitle').value = event.title || '';
  byId('evDesc').value = event.description || '';
  byId('evHours').value = event.active ? String(Math.max(1, Math.ceil((event.expiresAt - Date.now()) / 3600000))) : '24';
  const multiplier = String(event.winMultiplier || 1);
  if (![...byId('evMult').options].some(option => option.value === multiplier)) {
    byId('evMult').add(new Option('×' + multiplier, multiplier));
  }
  byId('evMult').value = multiplier;
  byId('evBonus').value = String(event.dailyBonus || 2000);
  posterVersion++;
  posterData = event.posterBase64 || '';
  posterDirty = false;
  posterLoading = false;
  byId('evPosterInput').value = '';
  posterPreview();
  updateEventButtons();
}

async function loadConfig() {
  const data = await request('/api/admin/config');
  renderRng(data.rngSettings || {});
  renderEvent(data.event || {});
}

async function restoreSession() {
  try {
    const session = await request('/api/admin/session', { allowUnauthorized: true });
    showPanel(session);
    await loadConfig();
  } catch (error) {
    if (error.stale) return;
    if (error.status === 401) showLogin();
    else if (csrfToken) status('globalStatus', error.message, true);
    else showLogin('Nie udało się połączyć z panelem. Spróbuj się zalogować.');
  }
}

byId('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = byId('loginBtn');
  button.disabled = true;
  status('loginStatus', 'Logowanie…');
  try {
    const session = await request('/api/admin/login', {
      method: 'POST', allowUnauthorized: true,
      body: { username: byId('adminUsername').value.trim(), password: byId('adminPassword').value }
    });
    showPanel(session);
    await loadConfig();
    status('loginStatus', '');
  } catch (error) {
    if (error.stale) return;
    if (csrfToken) status('globalStatus', error.message, true);
    else {
      byId('adminPassword').value = '';
      status('loginStatus', error.message, true);
    }
  } finally { button.disabled = false; }
});

byId('logoutBtn').addEventListener('click', async () => {
  byId('logoutBtn').disabled = true;
  try {
    await request('/api/admin/logout', { method: 'POST', body: {} });
    showLogin();
  } catch (error) {
    if (error.status !== 401) status('globalStatus', error.message, true);
  } finally { byId('logoutBtn').disabled = false; }
});

for (const [inputId, outputId] of sliders) {
  byId(inputId).addEventListener('input', () => {
    const value = Number(byId(inputId).value);
    byId(outputId).textContent = value > 0 ? '+' + value : String(value);
  });
}

byId('rngForm').addEventListener('submit', async event => {
  event.preventDefault();
  byId('saveRngBtn').disabled = true;
  status('rngStatus', 'Zapisywanie…');
  try {
    const rngSettings = Object.fromEntries(sliders.map(([inputId, , key]) => [key, Number(byId(inputId).value)]));
    const saved = await request('/api/admin/config', { method: 'POST', body: { rngSettings } });
    renderRng(saved.rngSettings);
    renderSummary(saved.event);
    status('rngStatus', 'Losowość została zapisana.');
  } catch (error) { status('rngStatus', error.message, true); }
  finally { byId('saveRngBtn').disabled = false; }
});

function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Nie udało się odczytać pliku.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Ten plik nie jest prawidłowym obrazem.'));
    image.src = source;
  });
}

byId('evPosterInput').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  const version = ++posterVersion;
  posterLoading = true;
  updateEventButtons();
  status('eventStatus', 'Przygotowywanie plakatu…');
  try {
    const signature = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const isGif = signature.length >= 6 && String.fromCharCode(...signature.slice(0, 6)).match(/^GIF8[79]a$/);
    if (isGif && file.size > MAX_GIF_BYTES) throw new Error('GIF jest za duży. Wybierz animację do około 1 MB.');
    if (!isGif && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      throw new Error('Wybierz GIF, JPG, PNG albo WebP.');
    }
    const source = await fileDataUrl(file);
    const image = await loadImage(source);
    let next;
    if (isGif) {
      if (image.naturalWidth > 1024 || image.naturalHeight > 1024) {
        throw new Error('GIF może mieć maksymalnie 1024 × 1024 piksele.');
      }
      // Do not draw a GIF on canvas: that would keep only one frame.
      next = 'data:image/gif;base64,' + source.slice(source.indexOf(',') + 1);
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 320;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Przeglądarka nie może przygotować plakatu.');
      const scale = Math.max(320 / image.naturalWidth, 320 / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      ctx.fillStyle = '#0c0e12';
      ctx.fillRect(0, 0, 320, 320);
      ctx.drawImage(image, (320 - width) / 2, (320 - height) / 2, width, height);
      next = canvas.toDataURL('image/jpeg', 0.84);
    }
    if (version !== posterVersion) return;
    posterData = next;
    posterDirty = true;
    posterPreview(isGif ? 'GIF · animacja zachowana' : 'Zdjęcie · dopasowane do zegarka');
    status('eventStatus', 'Plakat gotowy. Zapisz wydarzenie, aby wyświetlić go graczom.');
  } catch (error) {
    if (version === posterVersion) {
      byId('evPosterInput').value = '';
      status('eventStatus', error.message, true);
    }
  } finally {
    if (version === posterVersion) { posterLoading = false; updateEventButtons(); }
  }
});

byId('removePosterBtn').addEventListener('click', () => {
  posterVersion++;
  posterData = '';
  posterDirty = true;
  posterLoading = false;
  byId('evPosterInput').value = '';
  posterPreview();
  updateEventButtons();
  status('eventStatus', 'Plakat zostanie usunięty po zapisaniu wydarzenia.');
});

byId('eventForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (posterLoading || eventSaving) return;
  eventSaving = true;
  updateEventButtons();
  status('eventStatus', 'Zapisywanie…');
  try {
    const payload = {
      title: byId('evTitle').value.trim(), description: byId('evDesc').value.trim(),
      durationHours: Number(byId('evHours').value), winMultiplier: Number(byId('evMult').value),
      dailyBonus: Number(byId('evBonus').value)
    };
    if (posterDirty) payload.posterBase64 = posterData;
    const saved = await request('/api/admin/config', { method: 'POST', body: { event: payload } });
    renderEvent(saved.event);
    status('eventStatus', 'Wydarzenie jest aktywne. Plakat i bonusy są gotowe dla graczy.');
  } catch (error) { status('eventStatus', error.message, true); }
  finally { eventSaving = false; updateEventButtons(); }
});

byId('clearEventBtn').addEventListener('click', async () => {
  byId('clearEventBtn').disabled = true;
  eventSaving = true;
  updateEventButtons();
  status('eventStatus', 'Wyłączanie wydarzenia…');
  try {
    const saved = await request('/api/admin/config', { method: 'POST', body: { event: { clear: true } } });
    renderEvent(saved.event);
    status('eventStatus', 'Wydarzenie zostało wyłączone.');
  } catch (error) {
    status('eventStatus', error.message, true);
    byId('clearEventBtn').disabled = false;
  } finally { eventSaving = false; updateEventButtons(); }
});

function updateCountdown() {
  if (!expiresAt) return;
  const milliseconds = Math.max(0, expiresAt - Date.now());
  const h = Math.floor(milliseconds / 3600000);
  const m = Math.floor(milliseconds % 3600000 / 60000);
  const s = Math.floor(milliseconds % 60000 / 1000);
  byId('liveEventTimer').textContent = milliseconds ? 'Pozostało ' + h + 'h ' + m + 'm ' + s + 's' : 'Wydarzenie zakończone';
  if (!milliseconds) byId('eventStateLabel').textContent = 'WYDARZENIE ZAKOŃCZONE';
}

setInterval(updateCountdown, 1000);
window.addEventListener('pageshow', event => { if (event.persisted) restoreSession(); });
window.addEventListener('pagehide', () => showLogin());
restoreSession();
