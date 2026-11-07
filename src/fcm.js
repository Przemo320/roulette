'use strict';
const admin = require('firebase-admin');

let fcmReady = false;
let endingSoonTimer = null;
let endedTimer = null;

function initFcm() {
  if (fcmReady) return true;
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!rawJson) {
    console.warn('FCM: Brak zmiennej FIREBASE_SERVICE_ACCOUNT — powiadomienia push są wyłączone.');
    return false;
  }
  try {
    const serviceAccount = JSON.parse(rawJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    fcmReady = true;
    console.log('FCM: Połączono z Firebase Cloud Messaging.');
    return true;
  } catch (err) {
    console.error('FCM: Błąd inicjalizacji klucza Firebase:', err.message);
    return false;
  }
}

async function sendEventBroadcast(title, body, extraData = {}) {
  if (!initFcm()) return;
  try {
    await admin.messaging().send({
      topic: 'casino_events',
      notification: { title, body },
      data: {
        title,
        body,
        ...extraData
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'casino_events_channel',
          sound: 'default'
        }
      }
    });
  } catch (err) {
    console.error('FCM send error:', err.message);
  }
}

function clearEventTimers() {
  if (endingSoonTimer) { clearTimeout(endingSoonTimer); endingSoonTimer = null; }
  if (endedTimer) { clearTimeout(endedTimer); endedTimer = null; }
}

/**
 * Planuje automatyczne powiadomienia na 15 minut przed końcem ewentu
 * oraz w chwili jego wygaśnięcia.
 */
function scheduleEventTimers(event) {
  clearEventTimers();
  if (!event || !event.title || !event.expiresAt) return;

  const now = Date.now();
  const msUntilEnd = Number(event.expiresAt) - now;
  if (msUntilEnd <= 0) return;

  const fifteenMinMs = 15 * 60 * 1000;
  const msUntilWarning = msUntilEnd - fifteenMinMs;

  // Powiadomienie na 15 minut przed końcem (jeśli ewent trwa dłużej niż 20 minut)
  if (msUntilWarning > 0 && msUntilWarning < 2147483647) {
    endingSoonTimer = setTimeout(() => {
      sendEventBroadcast(
        `⏳ Kończy się: ${event.title}!`,
        `Ostatnie 15 minut na mnożnik ×${event.winMultiplier} i bonus ${event.dailyBonus} $!`,
        { type: 'event_ending_soon' }
      );
    }, msUntilWarning);
    endingSoonTimer.unref?.();
  }

  // Powiadomienie w momencie zakończenia ewentu
  if (msUntilEnd < 2147483647) {
    endedTimer = setTimeout(() => {
      sendEventBroadcast(
        `🏁 Ewent zakończony: ${event.title}`,
        'Wydarzenie dobiegło końca. Wypatruj kolejnego ewentu na zegarku!',
        { type: 'event_ended' }
      );
    }, msUntilEnd);
    endedTimer.unref?.();
  }
}

module.exports = {
  initFcm,
  sendEventBroadcast,
  scheduleEventTimers,
  clearEventTimers
};