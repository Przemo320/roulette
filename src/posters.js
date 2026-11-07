'use strict';
const { fail } = require('./games');
const MAX_POSTER_BYTES = 1_100_000;

function validatePoster(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 1_500_000) fail('Plakat jest za duży. Maksymalnie około 1 MB.');
  const match = /^data:image\/(gif|jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) fail('Wybierz plik GIF, JPG, PNG albo WebP.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_POSTER_BYTES || bytes.toString('base64') !== match[2]) {
    fail('Nieprawidłowy albo za duży plakat. Maksymalnie około 1 MB.');
  }
  const kind = match[1].toLowerCase();
  const valid = kind === 'gif' ? ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) && bytes.length >= 13
    : kind === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : kind === 'jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) fail('Zawartość pliku nie pasuje do wybranego formatu obrazu.');
  if (kind === 'gif' && (bytes.readUInt16LE(6) < 1 || bytes.readUInt16LE(8) < 1 ||
      bytes.readUInt16LE(6) > 1024 || bytes.readUInt16LE(8) > 1024)) {
    fail('GIF może mieć maksymalnie 1024 × 1024 piksele.');
  }
  // Keep the original bytes, including every GIF frame and its timing.
  return 'data:image/' + kind + ';base64,' + match[2];
}

module.exports = { validatePoster, MAX_POSTER_BYTES };
