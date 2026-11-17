'use strict';

/* ============================================================
   «Медиатека» — локальный плеер в стиле Apple Music.
   Треки хранятся в IndexedDB, играют через <audio> + Blob URL.
   ============================================================ */

/* ================= IndexedDB ================= */

const DB_NAME = 'my-music';
const DB_VERSION = 1;
const STORE_TRACKS = 'tracks';
const STORE_BLOBS = 'blobs';

const LAST_TRACK_KEY = 'player.lastTrack';
const SHUFFLE_KEY = 'player.shuffle';
const REPEAT_KEY = 'player.repeat';

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_TRACKS)) {
          database.createObjectStore(STORE_TRACKS, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(STORE_BLOBS)) {
          database.createObjectStore(STORE_BLOBS);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function dbRequest(storeName, mode, action) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error || new Error('Транзакция отменена'));
  });
}

const db = {
  get: (store, key) => dbRequest(store, 'readonly', (s) => s.get(key)),
  getAll: (store) => dbRequest(store, 'readonly', (s) => s.getAll()),
  put: (store, value, key) => dbRequest(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  remove: (store, key) => dbRequest(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => dbRequest(store, 'readwrite', (s) => s.clear()),
};

/* ================= Состояние ================= */

const state = {
  tracks: [],
  currentId: null,
  queue: [],
  filter: '',
  shuffle: false,
  repeat: 'off',
};

let objectURL = null;
let loadedTrackId = null;
let lastPositionUpdate = 0;
let toastTimer = null;
let userSeeking = false;

/* ================= DOM ================= */

const audio = document.getElementById('audio');
const list = document.getElementById('list');
const empty = document.getElementById('empty');
const noResults = document.getElementById('noResults');
const clearWrap = document.getElementById('clearWrap');
const searchWrap = document.getElementById('searchWrap');
const searchInput = document.getElementById('search');
const stats = document.getElementById('stats');
const sectionTitle = document.getElementById('sectionTitle');
const fileInput = document.getElementById('fileInput');

const miniPlayer = document.getElementById('player');
const miniArt = document.getElementById('miniArt');
const miniProgress = document.getElementById('miniProgress');
const playerTitle = document.getElementById('pTitle');
const playerArtist = document.getElementById('pArtist');
const playBtn = document.getElementById('playBtn');
const nextBtn = document.getElementById('nextBtn');

const nowPlaying = document.getElementById('nowPlaying');
const npBg = document.getElementById('npBg');
const npArt = document.getElementById('npArt');
const npTitle = document.getElementById('npTitle');
const npArtist = document.getElementById('npArtist');
const npSeek = document.getElementById('npSeek');
const npCur = document.getElementById('npCur');
const npRemain = document.getElementById('npRemain');
const npPlay = document.getElementById('npPlay');
const npPrev = document.getElementById('npPrev');
const npNext = document.getElementById('npNext');
const npShuffle = document.getElementById('npShuffle');
const npRepeat = document.getElementById('npRepeat');
const npClose = document.getElementById('npClose');

const toastElement = document.getElementById('toast');
const progress = document.getElementById('progress');
const progressText = document.getElementById('progressText');
const clearBtn = document.getElementById('clearBtn');
const addBtn = document.getElementById('addBtn');
const addBtn2 = document.getElementById('addBtn2');

const MORE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

/* ================= Утилиты ================= */

function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatSize(bytes) {
  if (!bytes) return '0 МБ';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1).replace('.', ',')} ГБ`;
  if (mb >= 10) return `${Math.round(mb)} МБ`;
  return `${mb.toFixed(1).replace('.', ',')} МБ`;
}

function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function extensionOf(fileName) {
  const match = /\.([^.]+)$/.exec(fileName || '');
  return match ? match[1].toUpperCase() : '';
}

function parseFileName(fileName) {
  const clean = (fileName || 'Без названия')
    .replace(/\.[^.]+$/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutIndex = clean.replace(/^\d{1,3}\s*[.\-)]\s*/, '');
  const parts = withoutIndex.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return {
      artist: parts[0].trim(),
      title: parts.slice(1).join(' - ').trim() || withoutIndex,
    };
  }
  return { artist: '', title: withoutIndex || clean };
}

const AUDIO_EXTENSION = /\.(mp3|m4a|m4b|aac|wav|flac|ogg|oga|opus|aiff?|caf|mp4)$/i;

function isAudioFile(file) {
  return Boolean(file) && ((file.type && file.type.startsWith('audio/')) || AUDIO_EXTENSION.test(file.name || ''));
}

function shuffleArray(items) {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function isQuotaError(error) {
  return Boolean(error) && (error.name === 'QuotaExceededError' || error.code === 22);
}

/* ================= Обложки ================= */

function hashString(value) {
  const text = String(value || 'music');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function artGradient(track) {
  const seed = hashString(`${track ? track.id : 'music'}${track ? track.title : ''}`);
  const hue1 = seed % 360;
  const hue2 = (hue1 + 40 + ((seed >>> 8) % 70)) % 360;
  const saturation = 58 + ((seed >>> 16) % 26);
  const light = 42 + ((seed >>> 4) % 14);
  return [
    `radial-gradient(120% 95% at 18% 8%, hsla(${hue1}, ${saturation}%, ${light + 20}%, 0.95), transparent 58%)`,
    `radial-gradient(110% 110% at 88% 18%, hsla(${hue2}, ${saturation}%, ${light + 4}%, 0.8), transparent 55%)`,
    `linear-gradient(155deg, hsl(${hue2}, ${saturation}%, ${light}%) 0%, hsl(${(hue2 + 32) % 360}, ${saturation}%, ${Math.max(14, light - 26)}%) 100%)`,
  ].join(', ');
}

function applyArt(element, track) {
  if (!element) return;
  element.style.backgroundImage = artGradient(track);
}

/* ================= Тост и прогресс ================= */

function showToast(message, duration = 2400) {
  toastElement.textContent = message;
  toastElement.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove('show'), duration);
}

function showProgress(message) {
  progressText.textContent = message;
  progress.hidden = false;
}

function hideProgress() {
  progress.hidden = true;
}

/* ================= Импорт файлов ================= */

function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('audio');
    let finished = false;

    const finish = (duration) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      probe.removeAttribute('src');
      probe.load();
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(duration) && duration > 0 ? duration : 0);
    };

    const timer = setTimeout(() => finish(0), 10000);
    probe.preload = 'metadata';
    probe.addEventListener('loadedmetadata', () => finish(probe.duration));
    probe.addEventListener('error', () => finish(0));
    probe.src = url;
  });
}

async function importFiles(fileList) {
  const all = Array.from(fileList || []);
  const files = all.filter(isAudioFile);
  const skipped = all.length - files.length;

  if (!files.length) {
    showToast('Среди файлов нет аудио');
    return;
  }

  if (navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => {});
  }

  let added = 0;
  let quotaReached = false;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    showProgress(`Добавляем ${index + 1} из ${files.length}`);
    try {
      const duration = await probeDuration(file);
      const { title, artist } = parseFileName(file.name);
      const id = makeId();
      const record = {
        id,
        name: file.name,
        title,
        artist,
        size: file.size,
        type: file.type || '',
        duration,
        addedAt: Date.now() + index,
      };
      await db.put(STORE_TRACKS, record);
      await db.put(STORE_BLOBS, file, id);
      added += 1;
    } catch (error) {
      console.error('Не удалось добавить файл', file.name, error);
      if (isQuotaError(error)) {
        quotaReached = true;
        break;
      }
    }
  }

  hideProgress();
  await loadLibrary();

  if (quotaReached) {
    showToast('В хранилище телефона не хватает места', 3600);
  } else if (added > 0) {
    showToast(added === 1 ? 'Песня добавлена' : `Добавлено: ${added} ${plural(added, 'песня', 'песни', 'песен')}`);
  } else {
    showToast('Не удалось добавить файлы', 3000);
  }

  if (skipped > 0) {
    setTimeout(() => showToast(`Пропущено файлов: ${skipped}`), 2000);
  }
}

/* ================= Медиатека ================= */

function getTrack(id) {
  return state.tracks.find((track) => track.id === id) || null;
}

function filteredTracks() {
  const query = state.filter.trim().toLowerCase();
  if (!query) return state.tracks;
  return state.tracks.filter((track) => {
    const haystack = `${track.title} ${track.artist} ${track.name}`.toLowerCase();
    return haystack.includes(query);
  });
}

function updateStats() {
  if (!state.tracks.length) {
    stats.textContent = 'Пока пусто';
    return;
  }
  const totalSize = state.tracks.reduce((sum, track) => sum + (track.size || 0), 0);
  const count = state.tracks.length;
  stats.textContent = `${count} ${plural(count, 'песня', 'песни', 'песен')} · ${formatSize(totalSize)}`;
}

function createTrackRow(track) {
  const item = document.createElement('li');
  item.className = 'track';
  item.dataset.id = track.id;
  if (track.id === state.currentId) item.classList.add('active');

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'track-main';
  main.setAttribute('aria-label', `Играть: ${track.title || track.name}`);

  const art = document.createElement('span');
  art.className = 'track-art';
  art.setAttribute('aria-hidden', 'true');
  applyArt(art, track);

  const text = document.createElement('span');
  text.className = 'track-text';

  const title = document.createElement('span');
  title.className = 'track-title';
  title.textContent = track.title || track.name || 'Без названия';

  const artist = document.createElement('span');
  artist.className = 'track-artist';
  artist.textContent = track.artist || extensionOf(track.name) || 'Аудио';

  text.append(title, artist);

  const duration = document.createElement('span');
  duration.className = 'track-dur track-dur-cell';
  duration.textContent = track.duration ? formatTime(track.duration) : '--:--';

  main.append(art, text, duration);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'track-del';
  remove.setAttribute('aria-label', `Удалить: ${track.title || track.name}`);
  remove.innerHTML = MORE_ICON;

  item.append(main, remove);
  return item;
}

function renderLibrary() {
  const tracks = filteredTracks();
  const total = state.tracks.length;

  empty.hidden = total > 0;
  searchWrap.hidden = total === 0;
  clearWrap.hidden = total === 0;
  sectionTitle.hidden = total === 0;
  noResults.hidden = !(total > 0 && tracks.length === 0);
  list.hidden = tracks.length === 0;

  list.textContent = '';
  const fragment = document.createDocumentFragment();
  tracks.forEach((track) => fragment.appendChild(createTrackRow(track)));
  list.appendChild(fragment);

  updateStats();
}

async function loadLibrary() {
  try {
    state.tracks = await db.getAll(STORE_TRACKS);
  } catch (error) {
    console.error('Не удалось прочитать медиатеку', error);
    state.tracks = [];
    showToast('Не удалось открыть медиатеку');
  }

  state.tracks.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));

  if (state.currentId && !getTrack(state.currentId)) {
    resetPlayback();
  }

  renderLibrary();
}

/* ================= Плеер ================= */

function setPlayingUI(playing) {
  [playBtn, npPlay].forEach((button) => {
    button.classList.toggle('playing', playing);
    button.setAttribute('aria-label', playing ? 'Пауза' : 'Играть');
  });
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }
}

function updateSeekUI(current, duration) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const ratio = safeDuration ? Math.min(Math.max(current / safeDuration, 0), 1) : 0;

  npSeek.value = String(Math.round(ratio * 1000));
  npSeek.style.setProperty('--p', `${ratio * 100}%`);
  miniProgress.style.width = `${ratio * 100}%`;
  npCur.textContent = formatTime(current);
  npRemain.textContent = `-${formatTime(Math.max(0, safeDuration - current))}`;
}

function renderPlayer(track) {
  const hasTrack = Boolean(track);
  miniPlayer.hidden = !hasTrack;
  document.body.classList.toggle('has-player', hasTrack);

  if (!hasTrack) {
    playerTitle.textContent = '—';
    playerArtist.textContent = '';
    if (!nowPlaying.hidden) closeNowPlaying();
    return;
  }

  const title = track.title || track.name || 'Без названия';
  const artist = track.artist || extensionOf(track.name) || 'Аудио';

  playerTitle.textContent = title;
  playerArtist.textContent = artist;
  applyArt(miniArt, track);

  npTitle.textContent = title;
  npArtist.textContent = artist;
  applyArt(npArt, track);
  applyArt(npBg, track);

  const duration = loadedTrackId === track.id && Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : track.duration;

  updateSeekUI(0, duration);
}

function openNowPlaying() {
  if (!state.currentId || nowPlaying.hidden === false) return;
  nowPlaying.hidden = false;
  document.body.classList.add('np-open');
  updateSeekUI(audio.currentTime || 0, audio.duration);
}

function closeNowPlaying() {
  nowPlaying.hidden = true;
  document.body.classList.remove('np-open');
}

function updateMediaSession(track) {
  if (!('mediaSession' in navigator) || !track) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || track.name || 'Без названия',
      artist: track.artist || 'Медиатека',
      album: 'Медиатека',
      artwork: [
        { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  } catch (error) {
    /* некоторые браузеры не поддерживают MediaMetadata */
  }
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(Math.max(audio.currentTime, 0), audio.duration),
    });
  } catch (error) {
    /* игнорируем */
  }
}

function registerMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  const session = navigator.mediaSession;
  const safe = (action, handler) => {
    try {
      session.setActionHandler(action, handler);
    } catch (error) {
      /* действие не поддерживается */
    }
  };

  safe('play', () => { audio.play().catch(() => {}); });
  safe('pause', () => audio.pause());
  safe('previoustrack', () => playPrevious());
  safe('nexttrack', () => playNext());
  safe('seekbackward', (details) => {
    audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10));
  });
  safe('seekforward', (details) => {
    audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (details.seekOffset || 10));
  });
  safe('seekto', (details) => {
    if (typeof details.seekTime === 'number') audio.currentTime = details.seekTime;
    if (details.fastSeek && typeof audio.fastSeek === 'function') audio.fastSeek(details.seekTime);
  });
}

function buildQueue(id) {
  const visible = filteredTracks().map((track) => track.id);
  let queue = visible.length ? visible : state.tracks.map((track) => track.id);
  if (state.shuffle) queue = shuffleArray(queue);
  if (!queue.includes(id)) queue.unshift(id);
  state.queue = queue;
}

function toggleShuffleQueue() {
  if (!state.currentId) return;
  const visible = filteredTracks().map((track) => track.id);
  const rest = visible.filter((id) => id !== state.currentId);
  if (state.shuffle) {
    state.queue = visible.includes(state.currentId)
      ? visible
      : [state.currentId, ...rest];
  } else {
    state.queue = [state.currentId, ...shuffleArray(rest)];
  }
}

async function prepareTrack(id, { resetTime = false } = {}) {
  if (loadedTrackId === id && audio.src) {
    if (resetTime) audio.currentTime = 0;
    return true;
  }

  let blob;
  try {
    blob = await db.get(STORE_BLOBS, id);
  } catch (error) {
    console.error('Не удалось прочитать файл', error);
  }

  if (!blob) {
    showToast('Файл не найден в хранилище', 3000);
    return false;
  }

  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = URL.createObjectURL(blob);
  audio.src = objectURL;
  loadedTrackId = id;
  if (resetTime) audio.currentTime = 0;
  return true;
}

async function playById(id, { autoplay = true, rebuildQueue = false } = {}) {
  const track = getTrack(id);
  if (!track) return;

  const switching = state.currentId !== id;
  state.currentId = id;
  localStorage.setItem(LAST_TRACK_KEY, id);

  if (rebuildQueue || !state.queue.length) {
    buildQueue(id);
  } else if (!state.queue.includes(id)) {
    state.queue.unshift(id);
  }

  const ready = await prepareTrack(id, { resetTime: switching });
  renderPlayer(track);
  renderLibrary();
  updateMediaSession(track);

  if (!ready || !autoplay) return;

  try {
    await audio.play();
  } catch (error) {
    console.warn('Браузер не разрешил воспроизведение', error);
    setPlayingUI(false);
  }
}

function togglePlay() {
  if (!state.currentId) {
    const first = filteredTracks()[0] || state.tracks[0];
    if (first) playById(first.id, { rebuildQueue: true });
    return;
  }

  if (audio.paused) {
    if (!audio.src) {
      playById(state.currentId);
      return;
    }
    audio.play().catch(() => showToast('Не удалось запустить воспроизведение'));
  } else {
    audio.pause();
  }
}

function playNext() {
  const queue = state.queue;
  if (!queue.length) return;
  const index = queue.indexOf(state.currentId);
  if (index === -1) {
    playById(queue[0]);
    return;
  }
  if (index + 1 < queue.length) {
    playById(queue[index + 1]);
  } else if (state.repeat === 'all') {
    playById(queue[0]);
  }
}

function playPrevious() {
  if (!audio.paused && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const queue = state.queue;
  if (!queue.length) return;
  const index = queue.indexOf(state.currentId);
  const target = index <= 0 ? queue[queue.length - 1] : queue[index - 1];
  playById(target);
}

function resetPlayback() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (objectURL) {
    URL.revokeObjectURL(objectURL);
    objectURL = null;
  }
  loadedTrackId = null;
  state.currentId = null;
  localStorage.removeItem(LAST_TRACK_KEY);
  renderPlayer(null);
  setPlayingUI(false);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  }
  renderLibrary();
}

/* ================= Удаление ================= */

async function removeTrack(id) {
  const track = getTrack(id);
  if (!track) return;
  const confirmed = window.confirm(`Удалить «${track.title || track.name}» из медиатеки?`);
  if (!confirmed) return;

  const wasCurrent = state.currentId === id;

  try {
    await db.remove(STORE_TRACKS, id);
    await db.remove(STORE_BLOBS, id);
  } catch (error) {
    console.error('Не удалось удалить песню', error);
    showToast('Не удалось удалить песню');
    return;
  }

  if (wasCurrent) resetPlayback();

  state.queue = state.queue.filter((queued) => queued !== id);
  await loadLibrary();
  showToast('Удалено из медиатеки');
}

async function clearLibrary() {
  if (!state.tracks.length) return;
  const confirmed = window.confirm('Удалить всю музыку из медиатеки? Файлы в «Файлах» останутся.');
  if (!confirmed) return;

  resetPlayback();
  try {
    await db.clear(STORE_TRACKS);
    await db.clear(STORE_BLOBS);
  } catch (error) {
    console.error('Не удалось очистить медиатеку', error);
    showToast('Не удалось очистить медиатеку');
  }
  state.queue = [];
  await loadLibrary();
  showToast('Медиатека очищена');
}

/* ================= Режимы ================= */

function updateModeButtons() {
  npShuffle.classList.toggle('on', state.shuffle);
  npShuffle.setAttribute('aria-pressed', String(state.shuffle));

  npRepeat.classList.toggle('on', state.repeat !== 'off');
  npRepeat.classList.toggle('one', state.repeat === 'one');
  npRepeat.setAttribute('aria-pressed', String(state.repeat !== 'off'));
  npRepeat.setAttribute('aria-label', state.repeat === 'off'
    ? 'Повтор выключен'
    : state.repeat === 'one'
      ? 'Повтор одной песни'
      : 'Повтор всех песен');
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  localStorage.setItem(SHUFFLE_KEY, state.shuffle ? '1' : '0');
  updateModeButtons();
  if (state.currentId) toggleShuffleQueue();
  showToast(state.shuffle ? 'Перемешивание включено' : 'Перемешивание выключено');
}

function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  localStorage.setItem(REPEAT_KEY, state.repeat);
  updateModeButtons();
  showToast(
    state.repeat === 'off'
      ? 'Повтор выключен'
      : state.repeat === 'one'
        ? 'Повтор одной песни'
        : 'Повтор всей медиатеки',
  );
}

/* ================= События аудио ================= */

function onLoadedMetadata() {
  const duration = audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;

  const track = getTrack(state.currentId);
  if (track && Math.abs((track.duration || 0) - duration) > 1) {
    track.duration = duration;
    db.put(STORE_TRACKS, track).catch(() => {});
    const row = list.querySelector(`.track[data-id="${track.id}"] .track-dur`);
    if (row) row.textContent = formatTime(duration);
  }

  updateSeekUI(audio.currentTime || 0, duration);
  updatePositionState();
}

function onTimeUpdate() {
  if (userSeeking) return;

  updateSeekUI(audio.currentTime, audio.duration);

  if (Date.now() - lastPositionUpdate > 900) {
    lastPositionUpdate = Date.now();
    updatePositionState();
  }
}

function onEnded() {
  if (state.repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }

  const queue = state.queue;
  const index = queue.indexOf(state.currentId);
  const nextId = index >= 0 && index + 1 < queue.length
    ? queue[index + 1]
    : state.repeat === 'all' && queue.length
      ? queue[0]
      : null;

  if (nextId) {
    playById(nextId);
  } else {
    audio.currentTime = 0;
    updateSeekUI(0, audio.duration);
    setPlayingUI(false);
  }
}

/* ================= Интерфейс ================= */

function pickFiles() {
  fileInput.click();
}

function bindEvents() {
  addBtn.addEventListener('click', pickFiles);
  addBtn2.addEventListener('click', pickFiles);

  fileInput.addEventListener('change', () => {
    // Копируем список до сброса value: FileList живой и очищается вместе с input
    const files = Array.from(fileInput.files || []);
    fileInput.value = '';
    if (files.length) importFiles(files);
  });

  list.addEventListener('click', (event) => {
    const removeButton = event.target.closest('.track-del');
    if (removeButton) {
      const item = removeButton.closest('.track');
      if (item) removeTrack(item.dataset.id);
      return;
    }

    const item = event.target.closest('.track');
    if (!item) return;
    const id = item.dataset.id;
    if (id === state.currentId) {
      togglePlay();
    } else {
      playById(id, { rebuildQueue: true });
    }
  });

  playBtn.addEventListener('click', togglePlay);
  npPlay.addEventListener('click', togglePlay);
  nextBtn.addEventListener('click', playNext);
  npNext.addEventListener('click', playNext);
  npPrev.addEventListener('click', playPrevious);
  npShuffle.addEventListener('click', toggleShuffle);
  npRepeat.addEventListener('click', cycleRepeat);
  npClose.addEventListener('click', closeNowPlaying);
  clearBtn.addEventListener('click', clearLibrary);

  miniPlayer.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    openNowPlaying();
  });

  searchInput.addEventListener('input', () => {
    state.filter = searchInput.value;
    renderLibrary();
  });

  const startSeeking = () => { userSeeking = true; };
  const stopSeeking = () => { userSeeking = false; };

  npSeek.addEventListener('pointerdown', startSeeking);
  npSeek.addEventListener('input', () => {
    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const position = (Number(npSeek.value) / 1000) * duration;
    audio.currentTime = position;
    updateSeekUI(position, duration);
  });
  npSeek.addEventListener('change', stopSeeking);
  npSeek.addEventListener('pointerup', stopSeeking);

  audio.addEventListener('play', () => setPlayingUI(true));
  audio.addEventListener('pause', () => setPlayingUI(false));
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('loadedmetadata', onLoadedMetadata);
  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('error', () => {
    if (audio.src) showToast('Не удалось воспроизвести файл', 3000);
  });

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
      importFiles(event.dataTransfer.files);
    }
  });

  document.addEventListener('keydown', (event) => {
    const tag = (event.target && event.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target.isContentEditable) return;

    if (event.code === 'Space') {
      event.preventDefault();
      togglePlay();
    } else if (event.key === 'Escape' && !nowPlaying.hidden) {
      closeNowPlaying();
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' })
        .catch((error) => console.error('Не удалось зарегистрировать service worker', error));
    });
  }
}

/* ================= Запуск ================= */

function restoreModes() {
  state.shuffle = localStorage.getItem(SHUFFLE_KEY) === '1';
  const repeat = localStorage.getItem(REPEAT_KEY);
  state.repeat = repeat === 'all' || repeat === 'one' ? repeat : 'off';
  updateModeButtons();
}

async function init() {
  bindEvents();
  registerMediaSessionHandlers();
  restoreModes();

  await loadLibrary();

  const lastId = localStorage.getItem(LAST_TRACK_KEY);
  const lastTrack = lastId ? getTrack(lastId) : null;

  if (lastTrack) {
    state.currentId = lastTrack.id;
    buildQueue(lastTrack.id);
    renderPlayer(lastTrack);
    updateMediaSession(lastTrack);
    setPlayingUI(false);

    try {
      const blob = await db.get(STORE_BLOBS, lastTrack.id);
      if (blob) {
        objectURL = URL.createObjectURL(blob);
        audio.src = objectURL;
        loadedTrackId = lastTrack.id;
      }
    } catch (error) {
      console.error('Не удалось подготовить последнюю песню', error);
    }
  } else {
    renderPlayer(null);
  }

  renderLibrary();

  // Заставка при запуске: скрываем, когда интерфейс уже готов
  setTimeout(() => {
    document.getElementById('splash').classList.add('hidden');
  }, 1600);
}

init();
