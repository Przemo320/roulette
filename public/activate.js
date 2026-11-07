'use strict';
const form = document.querySelector('#form');
const status = document.querySelector('#status');

// Obsługa parowania zegarka
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  status.textContent = 'Łączenie…';
  status.classList.remove('error');
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
    status.classList.add('error');
  } finally {
    button.disabled = false;
  }
});
