// share.js – ThreadMaps sharing and cloud sync

const SHARE_API = '/api/share';

// ─── Encryption helpers ────────────────────────────────────────────────────

export async function encryptTrip(tripData, password = null) {
  const json = JSON.stringify(tripData);
  if (!password) return json; // Unencrypted — for trusted sharing

  // Derive key from password using PBKDF2
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('threadmaps-v1'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(json));

  // Return IV + ciphertext as base64
  return btoa(String.fromCharCode(...iv)) + ':' + btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

export async function decryptTrip(encrypted, password) {
  if (!encrypted.includes(':')) return JSON.parse(encrypted); // Not encrypted

  const [ivB64, ctB64] = encrypted.split(':');
  const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0));

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('threadmaps-v1'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

// ─── Share trip ──────────────────────────────────────────────────────────

export async function shareTrip(tripData, options = {}) {
  const { password = null, expiresDays = 30, metaOnly = false } = options;

  const encrypted = await encryptTrip(metaOnly ? { name: tripData.name, description: tripData.description, waypoints: tripData.waypoints, strings: tripData.strings } : tripData, password);

  try {
    const resp = await fetch(SHARE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        encryptedData: encrypted,
        meta: { name: tripData.name, waypointCount: tripData.waypoints?.length || 0, sharedAt: Date.now() },
        expiresInDays
      })
    });
    if (!resp.ok) throw new Error('Server error: ' + resp.status);
    const result = await resp.json();
    return {
      id: result.id,
      url: `${window.location.origin}/view/${result.id}`,
      expiresAt: result.expiresAt,
      password
    };
  } catch(e) {
    // Fallback: encode in URL hash (works offline, no server needed)
    const compressed = btoa(encodeURIComponent(encrypted));
    const url = `${window.location.origin}/#share=${compressed}${password ? '&pw=1' : ''}`;
    return { id: 'local', url, expiresAt: null, password, offline: true };
  }
}

export async function loadSharedTrip(idOrHash) {
  // Try server first
  try {
    const resp = await fetch(`${SHARE_API}/${idOrHash}`);
    if (resp.ok) {
      const { encryptedData, meta } = await resp.json();
      return { encryptedData, meta, source: 'server' };
    }
  } catch {}

  // Fallback: decode from URL hash
  if (idOrHash.startsWith('#share=')) {
    const hash = idOrHash.slice(7);
    const password = hash.includes('&pw=1');
    const encrypted = decodeURIComponent(atob(hash.replace('&pw=1', '')));
    return { encryptedData: encrypted, meta: {}, source: 'hash', needsPassword: password };
  }
  return null;
}

// ─── Cloud sync via File System Access API ──────────────────────────────────
// Works with: Google Drive local folder, Dropbox, iCloud, OneDrive (desktop)
// On mobile: most cloud apps expose local folders too

let _syncFolder = null;
let _syncEnabled = false;

export async function requestSyncFolder() {
  if (!('showDirectoryPicker' in window)) {
    return { error: 'File System Access API not supported. Use Chrome or Edge.' };
  }
  try {
    _syncFolder = await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'documents'
    });
    _syncEnabled = true;
    // Store handle for persistence across page loads
    const handle = await _syncFolder.queryPermission({ mode: 'readwrite' });
    if (handle !== 'granted') {
      const perm = await _syncFolder.requestPermission();
      if (perm !== 'granted') {
        _syncEnabled = false;
        return { error: 'Permission denied' };
      }
    }
    localStorage.setItem('tm_sync_folder', _syncFolder.name || 'cloud-folder');
    return { ok: true, folderName: _syncFolder.name };
  } catch(e) {
    if (e.name === 'AbortError') return { cancelled: true };
    return { error: e.message };
  }
}

export async function syncToFolder(exportFn) {
  if (!_syncFolder || !_syncEnabled) return { error: 'No sync folder selected' };
  try {
    const data = await exportFn();
    const json = JSON.stringify(data, null, 2);
    const fileHandle = await _syncFolder.getFileHandle('threadmaps-backup.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(json);
    await writable.close();
    localStorage.setItem('tm_last_sync', Date.now().toString());
    return { ok: true, size: json.length };
  } catch(e) {
    return { error: e.message };
  }
}

export async function syncFromFolder(importFn) {
  if (!_syncFolder || !_syncEnabled) return { error: 'No sync folder selected' };
  try {
    const fileHandle = await _syncFolder.getFileHandle('threadmaps-backup.json');
    const file = await fileHandle.getFile();
    const text = await file.text();
    const data = JSON.parse(text);
    await importFn(data);
    return { ok: true, tripCount: data.trips?.length || 0 };
  } catch(e) {
    return { error: e.message };
  }
}

export function getSyncStatus() {
  const lastSync = localStorage.getItem('tm_last_sync');
  const folderName = localStorage.getItem('tm_sync_folder');
  return {
    enabled: _syncEnabled,
    folderName,
    lastSync: lastSync ? parseInt(lastSync) : null,
    lastSyncAgo: lastSync ? Date.now() - parseInt(lastSync) : null
  };
}

export function isSyncEnabled() { return _syncEnabled; }

// Auto-restore sync on load
(async () => {
  if ('showDirectoryPicker' in window) {
    try {
      const handles = await navigator.storage.persisted();
      // Check if we have persisted permission
      const persisted = await navigator.storage.persist();
      if (persisted) {
        const folderName = localStorage.getItem('tm_sync_folder');
        if (folderName) {
          // Can't auto-restore directory handle — user must re-select
          // But we can at least show the status
        }
      }
    } catch {}
  }
})();

// ─── Photo import from local folder ────────────────────────────────────────

let _photoFolder = null;

export async function requestPhotoFolder() {
  if (!('showDirectoryPicker' in window)) {
    return { error: 'File System Access API not supported' };
  }
  try {
    _photoFolder = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'pictures' });
    localStorage.setItem('tm_photo_folder', _photoFolder.name || 'photos');
    return { ok: true, folderName: _photoFolder.name };
  } catch(e) {
    if (e.name === 'AbortError') return { cancelled: true };
    return { error: e.message };
  }
}

export async function importPhotosFromFolder(waypointId, maxPhotos = 50) {
  if (!_photoFolder) return { error: 'No photo folder selected' };
  const results = [];
  try {
    let count = 0;
    for await (const entry of _photoFolder.values()) {
      if (!entry.kind === 'file' || count >= maxPhotos) break;
      const ext = entry.name.split('.').pop()?.toLowerCase();
      if (!['jpg', 'jpeg', 'png', 'webp', 'heic'].includes(ext)) continue;
      const file = await entry.getFile();
      const id = await window.db.photos.add({
        waypointId,
        date: file.lastModified,
        caption: entry.name,
        blobRef: entry.name, // relative filename
        _file: file // temporary, will be stored
      });
      results.push({ id, name: entry.name });
      count++;
    }
    return { ok: true, photos: results };
  } catch(e) {
    return { error: e.message };
  }
}

export async function getPhotoUrl(photo) {
  if (photo._file) {
    return URL.createObjectURL(photo._file);
  }
  // Try File System Access API
  if (_photoFolder && photo.blobRef) {
    try {
      const fileHandle = await _photoFolder.getFileHandle(photo.blobRef);
      const file = await fileHandle.getFile();
      return URL.createObjectURL(file);
    } catch {}
  }
  // Fallback to data URL from IndexedDB
  return null;
}

// ─── Share with nostr (optional, decentralized) ────────────────────────────

export async function shareViaNostr(tripData, relays = ['wss://relay.primal.net']) {
  if (!window.nostr) return { error: 'NIP-07 extension needed' };
  const npub = await window.nostr.getPublicKey();
  const event = await window.nostr.signEvent({
    kind: 31990, // Kind for travel/location data
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', tripData.name || 'trip'],
      ['type', 'threadmaps'],
      ['name', tripData.name || '']
    ],
    content: JSON.stringify(tripData)
  });
  for (const url of relays) {
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => { ws.send(JSON.stringify(['EVENT', event])); setTimeout(() => ws.close(), 2000); };
    } catch {}
  }
  return { id: event.id, npub };
}

// ─── User funnel — simple local account ────────────────────────────────────

export function setLocalUser(name, avatar = null) {
  const user = { name, avatar, created: Date.now(), id: generateId(8) };
  localStorage.setItem('tm_user', JSON.stringify(user));
  return user;
}

export function getLocalUser() {
  try {
    const raw = localStorage.getItem('tm_user');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function generateId(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, v => chars[v % chars.length]).join('');
}
