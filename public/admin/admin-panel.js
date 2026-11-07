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
let usersPage = 1;
let usersPages = 1;
let usersSearch = '';
let usersVersion = 0;
let detailVersion = 0;
let historyVersion = 0;
let selectedNick = '';
let historyPage = 1;
let historyPages = 1;
let userBusy = false;
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
  resetUsers();
  selectTab('settings', false);
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
  resetUsers();
  selectTab('settings', false);
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

function selectTab(name, load = true) {
  for (const key of ['settings', 'users']) {
    const selected = name === key;
    byId(key + 'Tab').setAttribute('aria-selected', String(selected));
    byId(key + 'Tab').tabIndex = selected ? 0 : -1;
    byId(key + 'Panel').hidden = !selected;
  }
  byId('panelTitle').textContent = name === 'users' ? 'Użytkownicy' : 'Ustawienia serwera';
  if (name === 'users' && load && csrfToken) loadUsers();
}

for (const key of ['settings', 'users']) {
  byId(key + 'Tab').addEventListener('click', () => selectTab(key));
  byId(key + 'Tab').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const name = event.key === 'Home' ? 'settings' : event.key === 'End' ? 'users' : key === 'users' ? 'settings' : 'users';
    selectTab(name);
    byId(name + 'Tab').focus();
  });
}

function closeUser() {
  detailVersion++;
  historyVersion++;
  selectedNick = '';
  historyPage = 1;
  historyPages = 1;
  byId('userDetail').hidden = true;
  byId('selectedUserTitle').textContent = '';
  byId('deleteNickLabel').textContent = '';
  byId('userEditForm').reset();
  byId('deleteUserForm').reset();
  byId('userStats').replaceChildren();
  byId('historyBody').replaceChildren();
  byId('historyPageLabel').textContent = '';
  status('userStatus', '');
  status('historyStatus', '');
  for (const row of byId('usersBody').rows) row.removeAttribute('data-selected');
}

function resetUsers() {
  usersVersion++;
  usersPage = 1;
  usersPages = 1;
  usersSearch = '';
  closeUser();
  byId('userSearchForm').reset();
  byId('usersBody').replaceChildren();
  byId('usersPageLabel').textContent = '';
  status('usersStatus', '');
  setUserBusy(false);
}

function updateUserButtons() {
  byId('usersPrev').disabled = userBusy || usersPage <= 1;
  byId('usersNext').disabled = userBusy || usersPage >= usersPages;
  byId('historyPrev').disabled = userBusy || historyPage <= 1;
  byId('historyNext').disabled = userBusy || historyPage >= historyPages;
  byId('deleteUserBtn').disabled = userBusy || !selectedNick || byId('deleteNick').value !== selectedNick;
}

function setUserBusy(value) {
  userBusy = value;
  for (const button of byId('usersPanel').querySelectorAll('button')) button.disabled = value;
  byId('editNick').disabled = value;
  byId('editPassword').disabled = value;
  byId('deleteNick').disabled = value;
  updateUserButtons();
}

function money(value) {
  try { return new Intl.NumberFormat('pl-PL').format(BigInt(String(value ?? 0))) + ' $'; }
  catch (_) { return '—'; }
}

function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('pl-PL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Warsaw' }).format(date);
}

function cell(row, text, className = '') {
  const td = document.createElement('td');
  td.textContent = text;
  td.className = className;
  row.append(td);
  return td;
}

function emptyTable(id, text) {
  const row = document.createElement('tr');
  const td = cell(row, text, 'empty-row');
  td.colSpan = 5;
  byId(id).replaceChildren(row);
}

async function loadUsers() {
  const version = ++usersVersion;
  status('usersStatus', 'Wczytywanie użytkowników…');
  emptyTable('usersBody', 'Wczytywanie…');
  try {
    const params = new URLSearchParams({ search: usersSearch, page: String(usersPage), limit: '12' });
    const data = await request('/api/admin/users?' + params);
    if (version !== usersVersion) return;
    usersPages = Math.max(1, Math.ceil(data.total / data.limit));
    if (usersPage > usersPages) { usersPage = usersPages; return loadUsers(); }
    const rows = data.users.map(user => {
      const row = document.createElement('tr');
      row.dataset.nick = user.nick;
      row.dataset.selected = String(user.nick === selectedNick);
      cell(row, user.nick);
      cell(row, money(user.credits), 'amount');
      cell(row, user.rounds);
      cell(row, dateTime(user.lastPlayedAt));
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'button-outline'; button.textContent = 'Otwórz';
      button.setAttribute('aria-label', 'Otwórz profil ' + user.nick);
      button.disabled = userBusy;
      button.addEventListener('click', () => openUser(user.nick, '', true));
      cell(row, '').append(button);
      return row;
    });
    if (rows.length) byId('usersBody').replaceChildren(...rows);
    else emptyTable('usersBody', usersSearch ? 'Brak użytkowników pasujących do wyszukiwania.' : 'Nie ma jeszcze kont graczy.');
    byId('usersPageLabel').textContent = 'Strona ' + usersPage + ' z ' + usersPages + ' · Konta: ' + data.total;
    status('usersStatus', '');
    updateUserButtons();
  } catch (error) {
    if (error.stale || version !== usersVersion) return;
    emptyTable('usersBody', 'Nie udało się pobrać listy.');
    status('usersStatus', error.message, true);
  }
}

function renderProfile(data) {
  const user = data.user, stats = data.stats;
  byId('selectedUserTitle').textContent = user.nick;
  byId('editNick').value = user.nick;
  byId('editPassword').value = '';
  byId('deleteNickLabel').textContent = user.nick;
  byId('deleteNick').value = '';
  const metrics = [
    ['Saldo', money(user.credits)], ['Rundy / w toku', stats.rounds + ' / ' + stats.active],
    ['Wygrane rundy', stats.wins], ['Wynik zakończonych gier', money(stats.profit)],
    ['Suma stawek', money(stats.wagered)], ['Suma wypłat', money(stats.returned)],
    ['Największa wypłata', money(stats.biggest)], ['Zalogowane zegarki', data.activeSessions]
  ];
  byId('userStats').replaceChildren(...metrics.map(([label, value]) => {
    const item = document.createElement('div'); item.className = 'stat-item';
    const name = document.createElement('small'); name.textContent = label;
    const number = document.createElement('strong'); number.textContent = value;
    item.append(name, number); return item;
  }));
  byId('userDetail').hidden = false;
  updateUserButtons();
}

async function openUser(nick, message = '', focus = false) {
  const version = ++detailVersion;
  historyVersion++;
  selectedNick = nick;
  historyPage = 1;
  byId('userDetail').hidden = true;
  byId('editPassword').value = '';
  status('usersStatus', 'Wczytywanie profilu ' + nick + '…');
  try {
    const data = await request('/api/admin/users/' + encodeURIComponent(nick));
    if (version !== detailVersion) return;
    renderProfile(data);
    for (const row of byId('usersBody').rows) row.dataset.selected = String(row.dataset.nick === nick);
    status('usersStatus', '');
    status('userStatus', message);
    await loadHistory();
    if (focus && version === detailVersion) byId('selectedUserTitle').focus();
  } catch (error) {
    if (error.stale || version !== detailVersion) return;
    closeUser();
    status('usersStatus', error.message, true);
  }
}

const gameNames = { roulette: 'Ruletka', slots: 'Automat 777', dice: 'Kości', blackjack: 'Blackjack', crash: 'Crash', plinko: 'Plinko', mines: 'Miny', wheel: 'Koło fortuny', hilo: 'Wyżej / niżej', baccarat: 'Baccarat' };

async function loadHistory() {
  if (!selectedNick) return;
  const nick = selectedNick, version = ++historyVersion;
  status('historyStatus', 'Wczytywanie historii…');
  emptyTable('historyBody', 'Wczytywanie…');
  try {
    const data = await request('/api/admin/users/' + encodeURIComponent(nick) + '/history?page=' + historyPage + '&limit=10');
    if (version !== historyVersion || nick !== selectedNick) return;
    historyPages = Math.max(1, Math.ceil(data.total / data.limit));
    if (historyPage > historyPages) { historyPage = historyPages; return loadHistory(); }
    const rows = data.rounds.map(round => {
      const row = document.createElement('tr');
      cell(row, dateTime(round.createdAt)); cell(row, gameNames[round.game] || round.game);
      cell(row, money(round.bet), 'amount'); cell(row, money(round.payout), 'amount');
      const active = round.status === 'active';
      const result = active ? 'W toku' : round.payout > round.bet ? 'Wygrana' : round.payout === round.bet ? 'Zwrot stawki' : 'Przegrana';
      const td = cell(row, result, active ? 'result-active' : round.payout > round.bet ? 'result-win' : round.payout < round.bet ? 'result-loss' : '');
      if (round.message) { const copy = document.createElement('span'); copy.className = 'result-copy'; copy.textContent = round.message; td.append(copy); }
      return row;
    });
    if (rows.length) byId('historyBody').replaceChildren(...rows);
    else emptyTable('historyBody', 'Ten gracz nie ma jeszcze zapisanych rund.');
    byId('historyPageLabel').textContent = 'Strona ' + historyPage + ' z ' + historyPages + ' · Rundy: ' + data.total;
    status('historyStatus', '');
    updateUserButtons();
  } catch (error) {
    if (error.stale || version !== historyVersion) return;
    emptyTable('historyBody', 'Nie udało się pobrać historii.');
    status('historyStatus', error.message, true);
  }
}

byId('userSearchForm').addEventListener('submit', event => {
  event.preventDefault(); if (userBusy) return;
  usersSearch = byId('userSearch').value.trim(); usersPage = 1; loadUsers();
});
byId('refreshUsersBtn').addEventListener('click', () => loadUsers());
byId('usersPrev').addEventListener('click', () => { if (usersPage > 1) { usersPage--; loadUsers(); } });
byId('usersNext').addEventListener('click', () => { if (usersPage < usersPages) { usersPage++; loadUsers(); } });
byId('historyPrev').addEventListener('click', () => { if (historyPage > 1) { historyPage--; loadHistory(); } });
byId('historyNext').addEventListener('click', () => { if (historyPage < historyPages) { historyPage++; loadHistory(); } });
byId('refreshHistoryBtn').addEventListener('click', async () => { if (selectedNick) await openUser(selectedNick); });
byId('closeUserBtn').addEventListener('click', () => { closeUser(); byId('usersTab').focus(); });
byId('deleteNick').addEventListener('input', updateUserButtons);

byId('userEditForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!selectedNick || userBusy) return;
  const nick = selectedNick, version = detailVersion;
  const body = { nick: byId('editNick').value.trim() };
  if (byId('editPassword').value) body.password = byId('editPassword').value;
  byId('editPassword').value = '';
  setUserBusy(true);
  status('userStatus', 'Zapisywanie konta…');
  try {
    const data = await request('/api/admin/users/' + encodeURIComponent(nick), { method: 'PATCH', body });
    if (version !== detailVersion) return;
    await openUser(data.user.nick, data.message);
    await loadUsers();
  } catch (error) {
    if (!error.stale && version === detailVersion) status('userStatus', error.message, true);
  } finally { setUserBusy(false); }
});

byId('deleteUserForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!selectedNick || userBusy || byId('deleteNick').value !== selectedNick) return;
  const nick = selectedNick, version = detailVersion;
  setUserBusy(true);
  status('userStatus', 'Usuwanie konta…');
  try {
    const data = await request('/api/admin/users/' + encodeURIComponent(nick), { method: 'DELETE', body: { confirmNick: byId('deleteNick').value } });
    if (version !== detailVersion) return;
    closeUser();
    await loadUsers();
    if (csrfToken) status('usersStatus', data.message);
  } catch (error) {
    if (!error.stale && version === detailVersion) status('userStatus', error.message, true);
  } finally { setUserBusy(false); }
});

setInterval(updateCountdown, 1000);
window.addEventListener('pageshow', event => { if (event.persisted) restoreSession(); });
window.addEventListener('pagehide', () => showLogin());
restoreSession();
