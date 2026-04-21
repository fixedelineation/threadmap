// main.js – ES module (Dexie is already a global variable)

// --------------------------------------------------------------
// 1️⃣ Dexie DB definition (includes new fields)
// --------------------------------------------------------------
export const db = new Dexie('ThreadMapDB');

db.version(3).stores({
  trips: '++id, name, created, status',
  waypoints: `
    ++id,
    tripId,
    lat,
    lng,
    layer,
    date,
    type,
    name,
    tags,
    status,
    rating,
    tripName
  `,
  strings: '++id, tripId, fromId, toId, mode, geometry',
  photos: '++id, waypointId, date'
});

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) *
            Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Find all waypoints within `radiusMeters` of the given lat/lng.
 */
export async function findNearbyWaypoints(lat, lng, radiusMeters = 100) {
  const all = await db.waypoints.toArray();
  return all.filter(
    wp => getDistance(lat, lng, wp.lat, wp.lng) <= radiusMeters
  );
}

// --------------------------------------------------------------
// 2️⃣ Helper to generate a human‑readable trip name (city + year)
// --------------------------------------------------------------
export async function generateTripName(lat, lng, dateObj) {
  const year = dateObj.getFullYear();
  try {
    const resp = await fetch(
      `https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`
    );
    const data = await resp.json();
    const city = data.city || data.state || data.country || null;
    return city ? `${city} ${year}` : `Trip ${year}`;
  } catch (_) {
    return `Trip ${year}`;
  }
}

// --------------------------------------------------------------
// 3️⃣ Pin visual helper – colour based on primary tag
// --------------------------------------------------------------
export function getPinHtml(layer, tags = []) {
  const tagColors = {
    restaurant: '#E67E22',
    attraction: '#3498DB',
    hotel: '#9B59B6',
    shop: '#F1C40F',
    misc: '#E74C3C',
    default: '#E74C3C'
  };
  const primaryTag = tags.find(t => tagColors[t]) || 'default';
  const baseColor = tagColors[primaryTag];

  const colors = [baseColor];
  let rings = '';
  for (let i = 0; i < layer; i++) {
    const size = 20 + i * 8;
    rings += `<div class="pin-ring" style="
      width:${size}px;
      height:${size}px;
      border-color:${colors[i % colors.length]};
      left:${-size / 2}px;
      top:${-size / 2}px;
      opacity:${1 - i * 0.2};
    "></div>`;
  }
  return `<div class="pin-container">${rings}<div class="pin-core"></div></div>`;
}

// --------------------------------------------------------------
// 4️⃣ Global state & map init
// --------------------------------------------------------------
export let map;
export const state = {
  selectedWaypoint: null,
  trip: null,       // current trip object (used by app-new.js)
  markers: new Map(),   // id → Leaflet marker
  lines: new Map(),     // "from-to" → polyline
  waypoints: new Map(), // id → waypoint data (for app-new.js)
  markerMap: new Map(), // id → Leaflet marker (alias for markers, for app-new.js)
  strings: new Map(),   // id → string data (for app-new.js)
  poiMarkers: []    // temporary POI markers from Explore
};


function makePinIcon(wp) {
  var colors = { pin:'#6366f1', hotel:'#f59e0b', restaurant:'#ef4444', cafe:'#8b5cf6', bar:'#ec4899', museum:'#14b8a6', park:'#22c55e', beach:'#06b6d4', church:'#f97316', shop:'#a855f7', flight:'#3b82f6', train:'#64748b', boat:'#0ea5e9', car:'#6b7280', walk:'#10b981' };
  var emojis = { hotel:'H', restaurant:'R', cafe:'C', bar:'B', museum:'M', park:'P', beach:'Be', church:'Ch', shop:'S', flight:'F', train:'T', boat:'Bo', car:'Ca', walk:'W' };
  var color = wp.color || colors[wp.type] || '#6366f1';
  var label = emojis[wp.type] || '';
  return L.divIcon({
    html: '<div style="background:'+color+';width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid white;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;color:white;box-shadow:0 2px 6px rgba(0,0,0,0.4)"><span style="transform:rotate(45deg)">'+label+'</span></div>',
    className: '', iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -28]
  });
}
var travelColors = { walk:'#22d3ee', bike:'#a3e635', car:'#fb923c', train:'#60a5fa', fly:'#c084fc', boat:'#38bdf8' };
var stringGroup = null; // set properly in initMap() after map exists
window.makePinIcon = makePinIcon;

export function initMap() {
  const mapEl = document.getElementById('map');
  if (!mapEl) return null;

  map = L.map('map', { zoomControl: false, attributionControl: false })
    .setView([48.8566, 2.3522], 13);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png')
    .addTo(map);

  L.control.zoom({ position: 'topright' }).addTo(map);

  // Re‑render strings when zoom changes (so arcs become visible/invisible)
  map.on('zoomend', () => renderStrings());

  // Click → deselect
  map.on('click', e => {
    if (e.originalEvent.target.id === 'map') deselectAll();
  });

  // Expose globally for app-new.js (must be synchronous, before any awaits)
  window.map = map;
  window.mapReady = true;
  stringGroup = L.layerGroup().addTo(map);
  window.stringGroup = stringGroup;

  return map;
}

function deselectAll() {
  state.selectedWaypoint = null;
  state.markers.forEach(m => m.getElement()?.classList.remove('selected'));
}

// --------------------------------------------------------------
// 5️⃣ OSRM routing (used when connecting two waypoints)
// --------------------------------------------------------------
async function fetchRoute(from, to, mode) {
  const style = travelStyles[mode];
  if (!style.profile) return null;
  try {
    const url = `https://router.project-osrm.org/route/v1/${style.profile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
    const resp = await fetch(url);
    const data = await resp.json();
    return data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
  } catch (e) {
    console.error('Routing error:', e);
    return null;
  }
}

// --------------------------------------------------------------
// 6️⃣ Travel‑mode styling (used for OSRM lines)
// --------------------------------------------------------------
const travelStyles = {
  flight: { color: '#00D2FF', dashArray: '10, 10', weight: 2, profile: null },
  train:  { color: '#9B59B6', dashArray: '5, 15', weight: 3, profile: 'car' },
  car:    { color: '#F1C40F', weight: 4, opacity: 0.8, profile: 'driving' },
  walk:   { color: '#2ECC71', dashArray: '2, 8', weight: 2, profile: 'walking' },
  boat:   { color: '#3498DB', dashArray: '15, 10', weight: 2, profile: null },
  other:  { color: '#FFFFFF', weight: 2, profile: null }
};

// --------------------------------------------------------------
// 7️⃣ Add a waypoint (called from UI & from POI‑save)
// --------------------------------------------------------------
export async function addWaypoint(latlng, data) {
  const {
    name = '',
    type = '',
    layer,
    tags = [],
    status = 'want',
    rating = null
  } = data;

  const tripName = await generateTripName(latlng.lat, latlng.lng, new Date());

  const id = await db.waypoints.add({
    tripId: 1,
    lat: latlng.lat,
    lng: latlng.lng,
    layer,
    date: new Date(),
    type,
    name,
    tags,
    status,
    rating,
    tripName
  });

  const marker = L.marker(latlng, {
    icon: L.divIcon({
      className: 'custom-pin',
      html: getPinHtml(layer, tags),
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    })
  }).addTo(map);

  marker.on('click', e => {
    L.DomEvent.stopPropagation(e);
    handleWaypointClick(id, marker);
  });

  state.markers.set(id, marker);
  return id;
}

// --------------------------------------------------------------
// 8️⃣ Click handling on existing way‑points
// --------------------------------------------------------------
async function handleWaypointClick(id, marker) {
  if (state.selectedWaypoint && state.selectedWaypoint !== id) {
    await connectWaypoints(state.selectedWaypoint, id);
    deselectAll();
  } else {
    deselectAll();
    state.selectedWaypoint = id;
    marker.getElement().classList.add('selected');
    window.showWaypointDetails(id);
  }
}

// --------------------------------------------------------------
// 9️⃣ Connect two way‑points (creates a line)
// --------------------------------------------------------------
async function connectWaypoints(fromId, toId) {
  const mode = await showModeSelector();
  if (!mode) return;

  const from = await db.waypoints.get(fromId);
  const to   = await db.waypoints.get(toId);
  const geometry = await fetchRoute(from, to, mode);
  await db.strings.add({ tripId: state.trip ? state.trip.id : 1, fromId, toId, mode, geometry });
  renderStrings();
}

// --------------------------------------------------------------
// 🔟 Render all strings (lines) – macro vs. micro view
// --------------------------------------------------------------
export async function renderStrings() {
    if (!map || !state.trip) return;
    if (!stringGroup) stringGroup = L.layerGroup().addTo(map);
    stringGroup.clearLayers();
    const strings = await db.strings.where('tripId').equals(state.trip.id).toArray();
    for (const s of strings) {
      let coords = [];
      if (s.fromId && s.toId) {
        const from = await db.waypoints.get(s.fromId);
        const to = await db.waypoints.get(s.toId);
        if (from && to) coords = [[from.lat, from.lng], [to.lat, to.lng]];
      } else if (s.geometry && s.geometry.coordinates) {
        coords = s.geometry.coordinates.map(c => [c[1], c[0]]);
      }
      if (coords.length >= 2) {
        const lineColor = travelColors[s.mode] || '#6366f1';
        const dash = s.mode === 'walk' ? '6 4' : s.mode === 'bike' ? '4 3' : null;
        L.polyline(coords, { color: lineColor, weight: 2.5, opacity: 0.75, dashArray: dash }).addTo(stringGroup);
      }
    }
  }
  window.renderStrings = renderStrings;

// --------------------------------------------------------------
// 1️⃣4️⃣ Load photos for a waypoint (grid view)
// --------------------------------------------------------------
async function loadPhotosForWaypoint(id) {
  const photos = await db.photos.where('waypointId').equals(parseInt(id)).toArray();
  const grid = document.getElementById('photo-grid');
  photos.forEach(p => {
    const url = URL.createObjectURL(p.data);
    const img = document.createElement('img');
    img.src = url;
    grid.appendChild(img);
  });
}

// --------------------------------------------------------------
// 1️⃣5️⃣ Save a POI discovered via the Explore button
// --------------------------------------------------------------
export async function savePOIAsWaypoint(lat, lng, name, type, category = 'all') {
  try {
    console.log('🟢 savePOIAsWaypoint →', { lat, lng, name, type, category });

    const defaultTagMap = {
      food: 'restaurant',
      culture: 'attraction',
      nature: 'attraction',
      shopping: 'shop',
      all: 'misc'
    };
    const defaultTag = defaultTagMap[category] || 'misc';

    const nearby = await findNearbyWaypoints(lat, lng, 50);
    const layer = nearby.length > 0 ? Math.max(...nearby.map(n => n.layer)) + 1 : 1;

    const waypointId = await addWaypoint(
      { lat, lng },
      {
        name,
        type,
        layer,
        tags: [defaultTag],
        status: 'want',
        rating: null
      }
    );
    showToast(`✅ Saved “${name || 'POI'}” as ${defaultTag}`);
    return waypointId;
  } catch (err) {
    console.error('❌ savePOIAsWaypoint FAILED:', err);
    showToast('❌ Failed to save POI – see console');
    throw err;
  }
}

// --------------------------------------------------------------
// 1️⃣6️⃣ Explore nearby places (Photon API) – now with a save button
// --------------------------------------------------------------
export async function exploreArea(category = 'all') {
  const btn = document.getElementById('explore-btn');
  const originalText = btn.innerText;
  btn.innerText = '⏳ Searching...';
  btn.disabled = true;

  // clear previous POI markers
  state.poiMarkers.forEach(m => map.removeLayer(m));
  state.poiMarkers = [];

  const center = map.getCenter();
  const query = categoryQueries[category] || categoryQueries.all;
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&lat=${center.lat}&lon=${center.lng}&limit=20`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();

    if (!data.features || data.features.length === 0) {
      alert(`No ${category} found here.`);
      return;
    }

    data.features.forEach(feature => {
      const [lon, lat] = feature.geometry.coordinates;
      const props = feature.properties;
      const color = categoryColors[category] || '#F1C40F';

      const marker = L.marker([lat, lon], {
        icon: L.divIcon({
          className: 'poi-pin',
          html: `<div style="
            background:${color};
            width:12px;height:12px;
            border-radius:50%;
            border:2px solid white;
            box-shadow:0 0 5px rgba(0,0,0,0.5);
          "></div>`,
          iconSize: [12, 12]
        })
      }).addTo(map);

      const name = props.name || 'Unnamed';
      const type = props.category || 'POI';

      // Popup HTML – includes a class‑based Save button
      const popupHTML = `
        <div style="color:black; font-family:sans-serif;">
          <b style="color:${color}">${name}</b><br>
          <span style="color:gray; font-size:11px;">${type}</span><br>
          <button class="save-poi-btn" style="
            margin-top:8px;
            background:#00D2FF;
            border:none;
            padding:6px 10px;
            border-radius:4px;
            cursor:pointer;
            font-weight:bold;
            width:100%;">⭐ Save to Trip</button>
        </div>
      `;
      marker.bindPopup(popupHTML);

      // Attach click handler when popup opens
      marker.on('popupopen', () => {
        const btn = document.querySelector('.leaflet-popup .save-poi-btn');
        if (!btn) {
          console.warn('⚠️ Save button not found in popup');
          return;
        }
        btn.onclick = async () => {
          console.log('🔘 Save POI clicked →', { lat, lng: lon, name, type, category });
          try {
            await savePOIAsWaypoint(lat, lon, name, type, category);
            marker.closePopup();
          } catch (e) {
            // errors already handled inside savePOIAsWaypoint
          }
        };
      });

      state.poiMarkers.push(marker);
    });
  } catch (e) {
    console.error('Explore error:', e);
    alert('Search engine unavailable – try again later.');
  } finally {
    btn.innerText = originalText;
    btn.disabled = false;
  }
}

// --------------------------------------------------------------
// 1️⃣7️⃣ Mode selector (modal that appears when you connect two pins)
// --------------------------------------------------------------
async function showModeSelector() {
  return new Promise(resolve => {
    const modal = document.getElementById('mode-modal');
    modal.style.display = 'flex';

    const handler = e => {
      const btn = e.target.closest('[data-mode]');
      if (btn) {
        modal.style.display = 'none';
        modal.removeEventListener('click', handler);
        resolve(btn.dataset.mode);
      }
    };
    modal.addEventListener('click', handler);
  });
}

// --------------------------------------------------------------
// 2️⃣0️⃣ Remove a waypoint (called from the side‑sheet delete button)
// --------------------------------------------------------------
export async function removeWaypointFromMap(id) {
  const marker = state.markers.get(id);
  if (marker) {
    map.removeLayer(marker);
    state.markers.delete(id);
  }
  state.lines.forEach((line, key) => {
    const [fromId, toId] = key.split('-');
    if (fromId == id || toId == id) {
      map.removeLayer(line);
      state.lines.delete(key);
    }
  });
}

// --------------------------------------------------------------

// --------------------------------------------------------------
// 2️⃣2️⃣ Toast helper – reusable across the app
// --------------------------------------------------------------
function showToast(message, duration = 3000) {
  let toast = document.getElementById('passive-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'passive-toast';
    toast.style.position = 'fixed';
    toast.style.top = '20px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%) translateY(-100px)';
    toast.style.background = 'rgba(0,0,0,0.9)';
    toast.style.color = 'white';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = '24px';
    toast.style.zIndex = '2000';
    toast.style.transition = 'transform 0.3s ease';
    toast.style.border = '1px solid #444';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  toast.style.transform = 'translateX(-50%) translateY(0)';

  setTimeout(() => {
    toast.style.transform = 'translateX(-50%) translateY(-100px)';
    toast.classList.remove('show');
  }, duration);
}

// --------------------------------------------------------------
// 2️⃣3️⃣ Expose the detail‑sheet function globally (timeline uses it)
// --------------------------------------------------------------
// showWaypointDetails, handleWaypointClick, renderTimeline exposed by app-new.js
window.renderTimeline = renderTimeline;

// Expose core module state for app-new.js (which references via window.*)
window.state = state;
window.db = db;
window.showAddModal = showAddModal;
window.addWaypoint = addWaypoint;

// --------------------------------------------------------------
// 2️⃣4️⃣ UI helpers & event wiring (run after DOM is ready)
// --------------------------------------------------------------
// Minimal init - new UI handled by app-new.js
// Modules are deferred — DOMContentLoaded may have already fired by now.
// Run initMap immediately if DOM is already ready.
// Map is already initialized by the inline <script> in index.html (which runs synchronously
// before this ES module). Do NOT re-init — that would create a duplicate Leaflet map.
(function initOnReady() {
  if (document.readyState !== 'loading') {
    // Map + stringGroup already set by inline script — just expose remaining globals
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      // Map already initialized by then via inline script
    });
  }
})();

/* --------------------------------------------------------------
   2️⃣5️⃣ Photo upload helper (stores blob in Dexie)
   -------------------------------------------------------------- */
async function handlePhotoUpload(file, waypointId) {
  const data = await file.arrayBuffer();
  await db.photos.add({ waypointId: parseInt(waypointId), date: new Date(), data: new Blob([data]) });
  // Refresh photo grid
  loadPhotosForWaypoint(waypointId);
}

/* --------------------------------------------------------------
   2️⃣6️⃣ Timeline rendering (bottom strip)
   -------------------------------------------------------------- */
async function renderTimeline({ filterTag = null, filterStatus = null } = {}) {
  const container = document.getElementById('timeline-strip');
  container.innerHTML = '';

  // Build query
  let collection = db.waypoints.orderBy('date');
  if (filterTag) collection = collection.filter(wp => wp.tags?.includes(filterTag));
  if (filterStatus) collection = collection.filter(wp => wp.status === filterStatus);

  const waypoints = await collection.toArray();

  waypoints.forEach(wp => {
    const item = document.createElement('div');
    item.className = 'timeline-item';
    item.style.display = 'inline-block';
    item.style.width = '80px';
    item.style.marginRight = '12px';
    item.style.cursor = 'pointer';
    item.style.textAlign = 'center';

    // Pin preview (same visual as on the map)
    const pin = document.createElement('div');
    pin.innerHTML = getPinHtml(wp.layer, wp.tags);
    pin.style.width = '40px';
    pin.style.height = '40px';
    pin.style.margin = '0 auto';
    item.appendChild(pin);

    const title = document.createElement('div');
    title.textContent = wp.name || wp.type || 'Untitled';
    title.style.fontSize = '11px';
    title.style.color = '#fff';
    title.style.marginTop = '4px';
    item.appendChild(title);

    const date = document.createElement('div');
    date.textContent = new Date(wp.date).toLocaleDateString();
    date.style.fontSize = '10px';
    date.style.color = '#aaa';
    item.appendChild(date);

    // Click opens the side‑sheet for editing
    item.onclick = () => {
      window.showWaypointDetails(wp.id);
    };

    container.appendChild(item);
  });
}

/* --------------------------------------------------------------
   2️⃣7️⃣ Trip headers (city + year) above the timeline strip
   -------------------------------------------------------------- */
async function renderTripHeaders() {
  const container = document.getElementById('timeline-strip');
  // Remove any existing headers
  const oldHeaders = container.querySelectorAll('.trip-header');
  oldHeaders.forEach(h => h.remove());

  const distinctNames = await db.waypoints
    .orderBy('date')
    .uniqueKeys('tripName')
    .then(names => names.filter(Boolean));

  distinctNames.forEach(name => {
    const header = document.createElement('div');
    header.className = 'trip-header';
    header.textContent = name;
    header.style.position = 'absolute';
    header.style.left = '0';
    header.style.top = '-20px';
    header.style.fontSize = '12px';
    header.style.color = '#fff';
    header.style.background = 'rgba(0,0,0,0.6)';
    header.style.padding = '2px 6px';
    header.style.borderRadius = '4px';
    container.appendChild(header);
  });
}

/* --------------------------------------------------------------
   2️⃣8️⃣ Timeline filter UI (tag & status)
   -------------------------------------------------------------- */
function renderTimelineFilters() {
  const wrapper = document.createElement('div');
  wrapper.style.position = 'fixed';
  wrapper.style.bottom = '130px';
  wrapper.style.right = '20px';
  wrapper.style.zIndex = '1000';
  wrapper.style.background = 'rgba(0,0,0,0.7)';
  wrapper.style.padding = '8px';
  wrapper.style.borderRadius = '8px';

  const tagSelect = document.createElement('select');
  const tagOptions = ['', 'restaurant', 'attraction', 'hotel', 'shop', 'misc'];
  tagOptions.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t ? t : 'All tags';
    tagSelect.appendChild(opt);
  });
  tagSelect.onchange = () => renderTimeline({ filterTag: tagSelect.value });

  const statusSelect = document.createElement('select');
  const statusOptions = ['', 'want', 'been'];
  statusOptions.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s ? s : 'All status';
    statusSelect.appendChild(opt);
  });
  statusSelect.onchange = () => renderTimeline({ filterStatus: statusSelect.value });

  wrapper.appendChild(tagSelect);
  wrapper.appendChild(document.createTextNode(' '));
  wrapper.appendChild(statusSelect);
  document.body.appendChild(wrapper);
}

/* --------------------------------------------------------------
   2️⃣9️⃣ Category → query mapping for the Photon API (used by Explore)
   -------------------------------------------------------------- */
const categoryQueries = {
  all: 'attraction',
  food: 'restaurant',
  culture: 'museum',
  nature: 'park',
  shopping: 'shop'
};

const categoryColors = {
  all: '#F1C40F',
  food: '#E67E22',
  culture: '#3498DB',
  nature: '#2ECC71',
  shopping: '#9B59B6'
};
