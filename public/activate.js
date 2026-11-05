'use strict';
const form = document.querySelector('#form');
const status = document.querySelector('#status');
const configForm = document.querySelector('#configForm');
const configStatus = document.querySelector('#configStatus');

let currentPosterBase64 = '';
let activeEventExpiresAt = 0;

// Obsługa parowania zegarka
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  status.textContent = 'Łączenie…';
  try {
    const data = Object.fromEntries(new FormData(form));
    const response = await fetch('/api/device/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || 'Błąd serwera');
    form.reset();
    status.textContent = json.message;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

// Powiązanie suwaków RNG z etykietami
const sliders = [
  ['rngRoulette', 'valRoulette'],
  ['rngSlots', 'valSlots'],
  ['rngDice', 'valDice'],
  ['rngCards', 'valCards'],
  ['rngSpecial', 'valSpecial']
];
for (const [inputId, labelId] of sliders) {
  const el = document.getElementById(inputId);
  const lbl = document.getElementById(labelId);
  el.addEventListener('input', () => {
    const v = Number(el.value);
    lbl.textContent = v > 0 ? `+${v}` : `${v}`;
  });
}

// Kompresja wgranego plakatu do rozmiaru 320x320 JPEG dla zegarka i strony
document.getElementById('evPosterInput').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const maxDim = 320;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      currentPosterBase64 = canvas.toDataURL('image/jpeg', 0.82);
      const preview = document.getElementById('posterDraftPreview');
      preview.src = currentPosterBase64;
      preview.hidden = false;
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

function renderConfigState(data) {
  const rng = data.rngSettings || {};
  document.getElementById('rngRoulette').value = rng.rouletteBias || 0;
  document.getElementById('rngSlots').value = rng.slotsBias || 0;
  document.getElementById('rngDice').value = rng.diceBias || 0;
  document.getElementById('rngCards').value = rng.cardsBias || 0;
  document.getElementById('rngSpecial').value = rng.specialBias || 0;
  for (const [inputId] of sliders) {
    document.getElementById(inputId).dispatchEvent(new Event('input'));
  }

  const ev = data.event || {};
  const banner = document.getElementById('activeEventSection');
  if (ev.active) {
    banner.hidden = false;
    document.getElementById('liveEventTitle').textContent = ev.title;
    document.getElementById('liveEventDesc').textContent = ev.description;
    document.getElementById('liveEventMult').textContent = `Mnożnik wygranych ×${ev.winMultiplier}`;
    document.getElementById('liveEventBonus').textContent = `Bonus dzienny: ${ev.dailyBonus} $`;
    activeEventExpiresAt = ev.expiresAt;

    const livePoster = document.getElementById('liveEventPoster');
    if (ev.posterBase64) {
      livePoster.src = ev.posterBase64;
      livePoster.hidden = false;
    } else {
      livePoster.hidden = true;
    }

    document.getElementById('evTitle').value = ev.title;
    document.getElementById('evDesc').value = ev.description;
    document.getElementById('evMult').value = String(ev.winMultiplier);
    document.getElementById('evBonus').value = ev.dailyBonus;
    currentPosterBase64 = ev.posterBase64 || '';
  } else {
    banner.hidden = true;
    activeEventExpiresAt = 0;
  }
}

async function loadPublicConfig() {
  try {
    const res = await fetch('/api/public/config');
    const json = await res.json();
    if (json.ok) renderConfigState(json);
  } catch (_) {}
}

configForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  configStatus.textContent = 'Zapisywanie…';
  try {
    const payload = {
      rngSettings: {
        rouletteBias: Number(document.getElementById('rngRoulette').value),
        slotsBias: Number(document.getElementById('rngSlots').value),
        diceBias: Number(document.getElementById('rngDice').value),
        cardsBias: Number(document.getElementById('rngCards').value),
        specialBias: Number(document.getElementById('rngSpecial').value)
      },
      event: {
        title: document.getElementById('evTitle').value.trim(),
        description: document.getElementById('evDesc').value.trim(),
        durationHours: Number(document.getElementById('evHours').value) || 24,
        winMultiplier: Number(document.getElementById('evMult').value) || 1.0,
        dailyBonus: Number(document.getElementById('evBonus').value) || 1000,
        posterBase64: currentPosterBase64
      }
    };
    const res = await fetch('/api/public/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Błąd zapisu');
    configStatus.textContent = json.message;
    renderConfigState(json);
  } catch (err) {
    configStatus.textContent = err.message;
  }
});

document.getElementById('clearEventBtn').addEventListener('click', async () => {
  configStatus.textContent = 'Wyłączanie ewentu…';
  try {
    const res = await fetch('/api/public/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: { clear: true } })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Błąd');
    currentPosterBase64 = '';
    document.getElementById('posterDraftPreview').hidden = true;
    configStatus.textContent = 'Ewent został wyłączony.';
    renderConfigState(json);
  } catch (err) {
    configStatus.textContent = err.message;
  }
});

setInterval(() => {
  if (!activeEventExpiresAt) return;
  const diff = Math.max(0, activeEventExpiresAt - Date.now());
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  document.getElementById('liveEventTimer').textContent =
    diff > 0 ? `Pozostało: ${h}h ${m}m ${s}s` : 'Ewent zakończony';
}, 1000);

loadPublicConfig();