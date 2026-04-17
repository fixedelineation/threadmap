// db.js – ThreadMaps database layer with migration
import Dexie from 'https://esm.sh/dexie@3.2.4';

export const db = new Dexie('ThreadMapDB_v2');

// Schema version 4 — adds:
// - waypoints.startedAt, waypoints.endedAt (thread timing)
// - trips.coverPhotoId, trips.shareId, trips.isPublic
// - photos.blobRef (file path instead of data URL)
// - trash.deletedAt, trash.type
db.version(4).stores({
  trips: '++id, name, created, status, startDate, endDate, shareId, isPublic',
  waypoints: '++id, tripId, lat, lng, layer, date, type, name, tags, status, rating, tripName, startedAt, endedAt',
  strings: '++id, tripId, fromId, toId, mode, geometry, startedAt, endedAt',
  photos: '++id, waypointId, date, blobRef',
  trash: '++id, deletedAt, type, name, --parentId'
});

// ─── Trip helpers ────────────────────────────────────────────────────────────

export async function createTrip(name, options = {}) {
  const now = Date.now();
  const id = await db.trips.add({
    name,
    description: options.description || '',
    color: options.color || '#6366f1',
    status: 'planning', // planning | active | completed
    startDate: options.startDate || now,
    endDate: options.endDate || null,
    coverPhotoId: null,
    shareId: null,
    isPublic: false,
    created: now,
    deleted: false,
    ...options
  });
  return id;
}

export async function completeTrip(tripId) {
  const trip = await db.trips.get(tripId);
  if (!trip) return;
  await db.trips.update(tripId, {
    status: 'completed',
    endDate: Date.now()
  });
  // Generate trip stats
  const waypoints = await db.waypoints.where('tripId').equals(tripId).toArray();
  const strings = await db.strings.where('tripId').equals(tripId).toArray();
  const photos = await db.photos.where('waypointId').anyOf(waypoints.map(w => w.id)).toArray();
  const totalDistance = await calculateTripDistance(tripId);
  return {
    totalPins: waypoints.length,
    totalPhotos: photos.length,
    totalDistance,
    days: waypoints.length ? Math.ceil((trip.endDate - trip.startDate) / 86400000) : 0
  };
}

export async function getTripStats(tripId) {
  const trip = await db.trips.get(tripId);
  if (!trip) return null;
  const waypoints = await db.waypoints.where('tripId').equals(tripId).toArray();
  const strings = await db.strings.where('tripId').equals(tripId).toArray();
  const photos = await db.photos.where('waypointId').anyOf(waypoints.map(w => w.id)).toArray();
  const totalDistance = await calculateTripDistance(tripId);
  return {
    name: trip.name,
    status: trip.status,
    startDate: trip.startDate,
    endDate: trip.endDate,
    totalPins: waypoints.length,
    totalPhotos: photos.length,
    totalDistance: Math.round(totalDistance * 10) / 10,
    days: trip.endDate && trip.startDate ? Math.max(1, Math.ceil((trip.endDate - trip.startDate) / 86400000) : 1
  };
}

async function calculateTripDistance(tripId) {
  const strings = await db.strings.where('tripId').equals(tripId).toArray();
  let total = 0;
  for (const s of strings) {
    if (s.geometry?.coordinates?.length > 1) {
      for (let i = 0; i < s.geometry.coordinates.length - 1; i++) {
        total += haversine(
          s.geometry.coordinates[i][1], s.geometry.coordinates[i][0],
          s.geometry.coordinates[i+1][1], s.geometry.coordinates[i+1][0]
        );
      }
    }
  }
  return total;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const d = Math.acos(
    Math.sin(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.cos((lon2 - lon1) * Math.PI / 180)
  ) * R;
  return d;
}

// ─── Waypoint helpers ────────────────────────────────────────────────────────

export async function addWaypoint(tripId, lat, lng, name, options = {}) {
  const now = Date.now();
  const existing = await db.waypoints.where('tripId').equals(tripId).count();
  const id = await db.waypoints.add({
    tripId, lat, lng,
    name: name || '',
    description: options.description || '',
    type: options.type || 'custom', // custom | explore | photo
    latlng: lat + ',' + lng,
    layer: options.layer || 'default',
    date: options.date || now,
    tags: options.tags || [],
    status: 'active',
    rating: options.rating || 0,
    created: now,
    deleted: false,
    startedAt: options.startedAt || null,
    endedAt: options.endedAt || null,
    tripName: options.tripName || ''
  });
  // Update trip bounds
  await updateTripBounds(tripId);
  return id;
}

export async function trashWaypoint(id) {
  const wp = await db.waypoints.get(id);
  if (!wp) return;
  await db.trash.add({
    type: 'waypoint',
    parentId: wp.tripId,
    name: wp.name,
    deletedAt: Date.now(),
    data: wp
  });
  await db.waypoints.update(id, { deleted: true, deletedAt: Date.now() });
  // Remove associated photos
  const photos = await db.photos.where('waypointId').equals(id).toArray();
  for (const p of photos) await trashPhoto(p.id);
  // Remove connected strings
  const strings = await db.strings.where('fromId').equals(id).or('toId').equals(id).toArray();
  for (const s of strings) await db.strings.update(s.id, { deleted: true });
}

export async function restoreFromTrash(trashId) {
  const item = await db.trash.get(trashId);
  if (!item) return;
  if (item.type === 'waypoint') {
    const data = item.data;
    delete data.deleted;
    delete data.deletedAt;
    await db.waypoints.add(data);
  } else if (item.type === 'string') {
    const data = item.data;
    delete data.deleted;
    await db.strings.add(data);
  } else if (item.type === 'trip') {
    const data = item.data;
    delete data.deleted;
    await db.trips.add(data);
  }
  await db.trash.delete(trashId);
}

export async function emptyTrash() {
  const old = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
  const oldItems = await db.trash.where('deletedAt').below(old).toArray();
  for (const item of oldItems) {
    // Actually delete associated data
    if (item.type === 'waypoint' && item.data?.blobRef) {
      // Would delete file here via FileSystem API
    }
    await db.trash.delete(item.id);
  }
  return oldItems.length;
}

// ─── Photo helpers ──────────────────────────────────────────────────────────

export async function addPhoto(waypointId, file, options = {}) {
  const id = await db.photos.add({
    waypointId,
    date: options.date || Date.now(),
    caption: options.caption || '',
    blobRef: options.blobRef || null // File System Access API path
  });
  return id;
}

export async function trashPhoto(id) {
  const photo = await db.photos.get(id);
  if (!photo) return;
  await db.trash.add({
    type: 'photo',
    parentId: photo.waypointId,
    name: photo.caption || 'Photo',
    deletedAt: Date.now(),
    data: photo
  });
  await db.photos.update(id, { deleted: true });
}

// ─── String (connection) helpers ───────────────────────────────────────────

export async function addString(tripId, fromId, toId, mode, geometry) {
  const id = await db.strings.add({
    tripId, fromId, toId,
    mode: mode || 'car', // car | walk | flight | train | boat
    geometry,
    deleted: false,
    created: Date.now()
  });
  return id;
}

// ─── Trip bounds ─────────────────────────────────────────────────────────────

async function updateTripBounds(tripId) {
  const wps = await db.waypoints.where('tripId').equals(tripId).toArray();
  if (!wps.length) return;
  const lats = wps.map(w => w.lat);
  const lngs = wps.map(w => w.lng);
  await db.trips.update(tripId, {
    bounds: {
      minLat: Math.min(...lats), maxLat: Math.max(...lats),
      minLng: Math.min(...lngs), maxLng: Math.max(...lngs)
    }
  });
}

// ─── Export / Import ────────────────────────────────────────────────────────

export async function exportTrip(tripId, includePhotos = false) {
  const trip = await db.trips.get(tripId);
  if (!trip) return null;
  const waypoints = await db.waypoints.where('tripId').equals(tripId).toArray();
  const strings = await db.strings.where('tripId').equals(tripId).toArray();
  let photos = [];
  if (includePhotos) {
    const wpIds = waypoints.map(w => w.id);
    photos = await db.photos.where('waypointId').anyOf(wpIds).toArray();
  }
  return { version: 2, exportedAt: Date.now(), trip, waypoints, strings, photos };
}

export async function importTrip(data, options = {}) {
  const { createNew = true } = options;
  const newTripId = createNew ? await createTrip(data.trip.name, {
    description: data.trip.description,
    color: data.trip.color,
    startDate: data.trip.startDate,
    endDate: data.trip.endDate
  }) : data.trip.id;

  const waypointIdMap = {}; // old id -> new id

  for (const wp of (data.waypoints || [])) {
    const oldId = wp.id;
    delete wp.id;
    wp.tripId = newTripId;
    wp.deleted = false;
    const newId = await db.waypoints.add(wp);
    waypointIdMap[oldId] = newId;
  }

  for (const s of (data.strings || [])) {
    delete s.id;
    s.tripId = newTripId;
    s.deleted = false;
    s.fromId = waypointIdMap[s.fromId] || s.fromId;
    s.toId = waypointIdMap[s.toId] || s.toId;
    await db.strings.add(s);
  }

  return newTripId;
}

export async function exportAllTrips() {
  const trips = await db.trips.where('deleted').notEqual(true).toArray();
  const result = { version: 2, exportedAt: Date.now(), trips };
  for (const trip of result.trips) {
    trip.waypoints = await db.waypoints.where('tripId').equals(trip.id).toArray();
    trip.strings = await db.strings.where('tripId').equals(trip.id).toArray();
    const wpIds = trip.waypoints.map(w => w.id);
    trip.photos = await db.photos.where('waypointId').anyOf(wpIds).toArray();
  }
  return result;
}

// ─── Search ─────────────────────────────────────────────────────────────────

export async function searchTrips(query) {
  const lower = query.toLowerCase();
  return db.trips.filter(t =>
    !t.deleted && (
      (t.name || '').toLowerCase().includes(lower) ||
      (t.description || '').toLowerCase().includes(lower)
    )
  ).toArray();
}

export async function searchWaypoints(query, tripId) {
  const lower = query.toLowerCase();
  let query2 = db.waypoints.filter(w =>
    !w.deleted && (
      (w.name || '').toLowerCase().includes(lower) ||
      (w.description || '').toLowerCase().includes(lower)
    )
  );
  if (tripId) {
    return (await query2.toArray()).filter(w => String(w.tripId) === String(tripId));
  }
  return query2.toArray();
}

// ─── Calendar helpers ───────────────────────────────────────────────────────

export async function getTripsForMonth(year, month) {
  const start = new Date(year, month, 1).getTime();
  const end = new Date(year, month + 1, 0, 23, 59, 59).getTime();
  return db.trips.filter(t =>
    !t.deleted && (
      (t.startDate && t.startDate >= start && t.startDate <= end) ||
      (t.endDate && t.endDate >= start && t.endDate <= end) ||
      (t.startDate && t.endDate && t.startDate <= start && t.endDate >= end)
    )
  ).toArray();
}

export async function getWaypointsForDay(timestamp) {
  const dayStart = new Date(timestamp).setHours(0, 0, 0, 0);
  const dayEnd = new Date(timestamp).setHours(23, 59, 59, 999);
  return db.waypoints.filter(w =>
    !w.deleted && w.date >= dayStart && w.date <= dayEnd
  ).toArray();
}

// ─── Trash ─────────────────────────────────────────────────────────────────

export async function getTrashItems() {
  return db.trash.orderBy('deletedAt').reverse().toArray();
}

// ─── Undo buffer ───────────────────────────────────────────────────────────
// Lightweight undo — stores last action in memory + localStorage

let _undoStack = [];
const MAX_UNDO = 20;

export function pushUndo(action) {
  _undoStack.push({ ...action, at: Date.now() });
  if (_undoStack.length > MAX_UNDO) _undoStack.shift();
  try { localStorage.setItem('tm_undo', JSON.stringify(_undoStack)); } catch {}
}

export function getUndoStack() {
  return [..._undoStack];
}

export function clearUndo() {
  _undoStack = [];
  localStorage.removeItem('tm_undo');
}

// Load undo from localStorage
try {
  const saved = localStorage.getItem('tm_undo');
  if (saved) _undoStack = JSON.parse(saved);
} catch {}

window._tmDb = db;
window._tmUndo = { push: pushUndo, get: getUndoStack, clear: clearUndo };
