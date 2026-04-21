// app-new.js - ThreadMaps new UI layer
// Removed broken import - accessing globals via window
import { shareTrip, getSyncStatus, requestSyncFolder, syncToFolder, syncFromFolder, requestPhotoFolder, decryptTrip, loadSharedTrip, shareViaNostr } from './share.js';
import { db, state, map, renderStrings } from './main.js';

const TRASH_DAYS = 7;
var calYear = new Date().getFullYear();
var calMonth = new Date().getMonth();
var sidebarView = 'trips';
var exploreMode = 'nearby';
var sortMode = 'sequence';
var lightMode = localStorage.getItem('tm_theme') === 'light';

window.addEventListener('DOMContentLoaded', async function() {
  // Wait for main.js to init the Leaflet map (it runs after us)
  if (!window.mapReady) {
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (window.mapReady) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });
  }
  // Also wait for Dexie DB to be ready (version migration complete)
  if (window.db && window.db.isOpen !== undefined && !window.db.isOpen()) {
    await window.db.open().catch(() => {});
  }
  if (window.map) {
    window.map.invalidateSize();
    // Click on empty map → add pin at that location
    // (Long-press still works on touch devices below.)
    window.map.on('click', e => {
      const tgt = e.originalEvent.target;
      // Ignore clicks on existing markers, popups, or controls
      if (tgt.closest('.leaflet-marker-icon') || tgt.closest('.leaflet-popup') ||
          tgt.closest('.leaflet-control') || tgt.closest('.waypoint-marker')) return;
      if (typeof window.openWaypointModal === 'function') {
        window.openWaypointModal(e.latlng.lat, e.latlng.lng);
      }
    });
    // Touch long-press fallback (some mobile browsers don't fire click cleanly)
    let pressTimer, pressMoved = false;
    window.map.on('touchstart', e => {
      pressMoved = false;
      const tgt = e.originalEvent && e.originalEvent.target;
      if (tgt && (tgt.closest('.leaflet-marker-icon') || tgt.closest('.leaflet-popup') || tgt.closest('.leaflet-control'))) return;
      pressTimer = setTimeout(() => {
        if (!pressMoved && typeof window.openWaypointModal === 'function') {
          // Use Leaflet's containerPointToLatLng for the touch position
          const touch = e.touches && e.touches[0];
          if (!touch) return;
          const rect = window.map.getContainer().getBoundingClientRect();
          const point = window.L.point(touch.clientX - rect.left, touch.clientY - rect.top);
          const ll = window.map.containerPointToLatLng(point);
          window.openWaypointModal(ll.lat, ll.lng);
        }
      }, 500);
    }, { passive: true });
    window.map.on('touchmove', () => { pressMoved = true; clearTimeout(pressTimer); }, { passive: true });
    window.map.on('touchend', () => clearTimeout(pressTimer), { passive: true });
  }
  initTheme();
  try { await loadTrips(); } catch(e) { console.warn('loadTrips:', e); }
  try { await renderCalendar(); } catch(e) { console.warn('renderCalendar:', e); }
  await updateTrashBadge();
  updateSyncStatus();
  checkSharedTrip();
  startTrashSweep();
  document.addEventListener('click', function(e) {
    if (!e.target.closest('.fab-menu') && !e.target.closest('.fab') && !e.target.closest('.explore-bar')) closeFAB();
    if (!e.target.closest('.header-center')) { var sr = document.getElementById('searchResults'); if (sr) sr.classList.remove('open'); }
  });
});

function initTheme() { if (lightMode) document.body.classList.add('light'); }

window.toggleTheme = function() {
  lightMode = !lightMode;
  document.body.classList.toggle('light', lightMode);
  localStorage.setItem('tm_theme', lightMode ? 'light' : 'dark');
};

window.switchSidebarView = function(view) {
  sidebarView = view;
  document.querySelectorAll('.sidebar-tab').forEach(function(t) {
    var txt = t.textContent.trim().toLowerCase();
    t.classList.toggle('active', txt.startsWith(view));
  });
  document.getElementById('tripsView').style.display = view === 'trips' ? '' : 'none';
  document.getElementById('calendarView').style.display = view === 'calendar' ? '' : 'none';
  document.getElementById('trashView').style.display = view === 'trash' ? '' : 'none';
  if (view === 'trash') loadTrash();
};

window.switchExplore = function(mode) {
  exploreMode = mode;
  document.querySelectorAll('.explore-tab').forEach(function(t) { t.classList.toggle('active', t.textContent.toLowerCase().includes(mode)); });
  if (mode === 'nearby' && state.selectedWaypoint) {
    var wp = state.waypoints.get(state.selectedWaypoint);
    if (wp) doExplore(wp.lat, wp.lng);
  }
};

window.sortWaypoints = function(mode) {
  sortMode = mode;
  document.querySelectorAll('.tl-sort-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.sort === mode); });
  renderTimeline();
};

window.openFAB = function() {
  var m = document.getElementById('fabMenu');
  m.style.display = m.style.display === 'none' ? 'flex' : 'none';
};

window.closeFAB = function() { document.getElementById('fabMenu').style.display = 'none'; };
window.newTrip = function() { closeFAB(); openTripModal(); };
window.addCurrentPin = function() {
  closeFAB();
  // Prefer the selected waypoint's location, otherwise fall back to map center.
  var lat, lng;
  if (state.selectedWaypoint && state.waypoints.get(state.selectedWaypoint)) {
    var wp = state.waypoints.get(state.selectedWaypoint);
    lat = wp.lat; lng = wp.lng;
  } else if (window.map) {
    var c = window.map.getCenter();
    lat = c.lat; lng = c.lng;
  } else {
    return;
  }
  openWaypointModal(lat, lng);
};
// Toggle Explore bar — uses selected pin, otherwise map center
window.toggleExplore = function() {
  var bar = document.getElementById('exploreBar');
  if (bar.style.display === 'flex' || getComputedStyle(bar).display === 'flex') {
    bar.style.display = 'none';
    return;
  }
  var lat, lng;
  if (state.selectedWaypoint && state.waypoints.get(state.selectedWaypoint)) {
    var w = state.waypoints.get(state.selectedWaypoint);
    lat = w.lat; lng = w.lng;
  } else if (window.map) {
    var c = window.map.getCenter();
    lat = c.lat; lng = c.lng;
  } else { return; }
  switchExplore('nearby');
  doExplore(lat, lng);
};

window.exploreCurrentPin = function() {
  closeFAB();
  if (state.selectedWaypoint) {
    var wp = state.waypoints.get(state.selectedWaypoint);
    if (wp) { switchExplore('nearby'); doExplore(wp.lat, wp.lng); }
  }
};
window.addFromGPS = function() {
  closeFAB();
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    function(pos) { openWaypointModal(pos.coords.latitude, pos.coords.longitude); },
    function(err) { alert('Location error: ' + err.message); }
  );
};

window.openTripModal = function(trip) {
  trip = trip || null;
  document.getElementById('tripModalTitle').textContent = trip ? 'Edit Trip' : 'New Trip';
  document.getElementById('tripName').value = trip ? trip.name : '';
  document.getElementById('tripDesc').value = trip ? (trip.description || '') : '';
  document.getElementById('tripStart').value = trip ? (trip.startDate || '') : '';
  document.getElementById('tripEnd').value = trip ? (trip.endDate || '') : '';
  document.getElementById('tripModal').dataset.editId = trip ? trip.id : '';
  document.getElementById('coverPreview').style.display = 'none';
  if (trip && trip.color) selectColor(trip.color);
  openModal('tripModal');
};

window.saveTripModal = async function() {
  var name = document.getElementById('tripName').value.trim();
  if (!name) { alert('Trip name required'); return; }
  var editId = document.getElementById('tripModal').dataset.editId;
  var colorEl = document.querySelector('.color-swatch.active');
  var tripData = {
    name: name,
    description: document.getElementById('tripDesc').value.trim(),
    startDate: document.getElementById('tripStart').value,
    endDate: document.getElementById('tripEnd').value,
    color: colorEl ? colorEl.dataset.color : '#6366f1',
    updatedAt: Date.now()
  };
  if (editId) {
    await db.trips.update(parseInt(editId), tripData);
    await db.waypoints.where('tripId').equals(parseInt(editId)).modify({ tripName: name });
  } else {
    tripData.status = 'planning';
    tripData.created = Date.now();
    tripData.coverPhoto = null;
    var id = await db.trips.add(tripData);
    tripData.id = id;
  }
  closeModal('tripModal');
  await loadTrips();
  if (tripData.id) selectTrip(tripData.id);
};

window.selectColor = function(color) {
  document.querySelectorAll('.color-swatch').forEach(function(s) { s.classList.toggle('active', s.dataset.color === color); });
};

window.pickCoverPhoto = function() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = function(e) {
    var file = e.target.files[0];
    if (!file) return;
    document.getElementById('coverImg').src = URL.createObjectURL(file);
    document.getElementById('coverPreview').style.display = '';
  };
  input.click();
};

window.setCoverFromPin = function() {
  if (state.selectedWaypoint) {
    var wp = state.waypoints.get(state.selectedWaypoint);
    if (wp && wp.photo) {
      document.getElementById('coverImg').src = wp.photo;
      document.getElementById('coverPreview').style.display = '';
    }
};


// ─── Trips list ───────────────────────────────────────────────────────────
async function loadTrips() {
  var trips = await db.trips.orderBy('created').reverse().toArray();
  var container = document.getElementById('tripList');
  if (!trips.filter(function(t) { return t.status !== 'trash'; }).length) {
    container.innerHTML = '<p style="padding:16px;font-size:0.8rem;color:var(--fg-muted)">No trips yet. Tap + to create one.</p>';
    return;
  }
  container.innerHTML = '';
  container.innerHTML = '';
  for (var i = 0; i < trips.length; i++) {
    var trip = trips[i];
    if (trip.status === 'trash') continue;
    var days = trip.endDate && trip.startDate ? Math.ceil((new Date(trip.endDate) - new Date(trip.startDate)) / 86400000) + 1 : 1;
    var el = document.createElement('div');
    el.className = 'trip-card' + (state.trip && state.trip.id === trip.id ? ' active' : '');
    el.style.setProperty('--trip-color', trip.color || '#6366f1');
    el.innerHTML = '<div class="trip-card-name">' + escHtml(trip.name) + '</div>' +
      '<div class="trip-card-meta">' +
      '<span class="trip-badge badge-' + (trip.status || 'planning') + '">' + (trip.status || 'planning') + '</span>' +
      '<span>' + (trip._wpCount || 0) + ' pin' + ((trip._wpCount||0) !== 1 ? 's' : '') + '</span>' +
      '<span>' + days + 'd</span>' +
      (trip.startDate ? '<span>' + trip.startDate + '</span>' : '') + '</div>';
    el.onclick = function(tripId) { return function() { selectTrip(tripId); }; }(trip.id);
    container.appendChild(el);
  }
}
}

window.selectTrip = async function(id) {
  var trip = await db.trips.get(id);
  if (!trip) return;
  state.trip = trip;
  state.waypoints.clear();
  state.strings.clear();
  state.markers.forEach(function(m) { m.remove(); });
  state.markers.clear();
  state.markerMap.clear();
  state.selectedWaypoint = null;
  var wps = await db.waypoints.where('tripId').equals(id).toArray();
  wps.forEach(function(wp) { state.waypoints.set(wp.id, wp); });
  state.waypoints.forEach(function(wp, wpId) {
    var m = L.marker([wp.lat, wp.lng], { icon: makePinIcon(wp) }).addTo(map);
    m.on('click', function() { handleWaypointClick(wpId, m); });
    m.on('contextmenu', function(e) { L.DomEvent.stopPropagation(e); showWaypointDetails(wpId); });
    state.markers.set(wpId, m);
    state.markerMap.set(wpId, m);
  });
  if (wps.length) {
    var group = L.featureGroup(Array.from(state.markers));
    map.fitBounds(group.getBounds().pad(0.1));
  }
  document.getElementById('tripBanner').style.display = '';
  document.getElementById('tripBannerName').textContent = trip.name;
  document.getElementById('tripBannerStats').textContent = (wps.length === 1 ? '1 pin' : wps.length + ' pins');
  document.getElementById('timeline').style.display = wps.length > 1 ? '' : 'none';
  document.getElementById('timelineControls').style.display = wps.length > 1 ? '' : 'none';
  renderTimeline();
  renderStrings();
  await renderCalendar();
  await loadTrips();
};

window.closeTrip = function() {
  state.trip = null;
  state.waypoints.clear();
  state.strings.clear();
  state.markers.forEach(function(m) { m.remove(); });
  state.markers.clear();
  state.markerMap.clear();
  state.selectedWaypoint = null;
  document.getElementById('tripBanner').style.display = 'none';
  document.getElementById('timeline').style.display = 'none';
  document.getElementById('timelineControls').style.display = 'none';
  document.getElementById('fabMenu').style.display = 'none';
  loadTrips();
};

window.editTripBanner = function() { if (state.trip) openTripModal(state.trip); };

window.completeCurrentTrip = async function() {
  if (!state.trip) return;
  await db.trips.update(state.trip.id, { status: 'completed', completedAt: Date.now() });
  state.trip.status = 'completed';
  document.getElementById('tripBannerStats').textContent = 'Completed';
  await loadTrips();
};

// ─── Timeline ────────────────────────────────────────────────────────────
var activeTimelineWpId = null;
function renderTimeline() {
  var scroll = document.getElementById('timelineScroll');
  if (!scroll) return;
  var wps = Array.from(state.waypoints.values());
  var sorted = wps.slice().sort(function(a,b) {
    if (sortMode === 'date') return (a.date||'').localeCompare(b.date||'');
    if (sortMode === 'name') return (a.name||'').localeCompare(b.name||'');
    return (a.sequence||0) - (b.sequence||0);
  });
  scroll.innerHTML = '';
  sorted.forEach(function(wp, idx) {
    var item = document.createElement('div');
    item.className = 'timeline-item' + (activeTimelineWpId === wp.id ? ' active' : '');
    var icon = wp.type === 'flight' ? '\u2708' : wp.type === 'train' ? '\uD83D\uDE8C' : wp.type === 'car' ? '\uD83D\uDE97' : wp.type === 'boat' ? '\uD83D\uDEA2' : wp.type === 'bike' ? '\uD83D\uDEB2' : '\uD83D\uDCCD';
    var dateLabel = wp.date ? wp.date.split('-').slice(1).join('/') : (idx + 1 + '');
    item.innerHTML = '<div class="tl-dot" style="background:' + (wp.color || '#6366f1') + '">' + icon + '</div>' +
      '<div class="timeline-item-name">' + escHtml(wp.name || 'Pin') + '</div>' +
      '<div class="timeline-item-date">' + dateLabel + '</div>';
    item.onmouseenter = function() {
      activeTimelineWpId = wp.id;
      highlightTimelinePin(wp.id);
      var m = state.markerMap.get(wp.id);
      if (m) m.getElement()?.classList.add('highlighted');
    };
    item.onmouseleave = function() {
      if (activeTimelineWpId === wp.id) activeTimelineWpId = null;
      clearTimelineHighlight();
    };
    item.onclick = function() {
      activeTimelineWpId = wp.id;
      renderTimeline();
      var m = state.markerMap.get(wp.id);
      if (m) {
        map.setView(m.getLatLng(), 16);
        if (typeof handleWaypointClick === 'function') handleWaypointClick(wp.id, m);
        else if (window.handleWaypointClick) window.handleWaypointClick(wp.id, m);
      }
    };
    scroll.appendChild(item);
  });
}

// Dim all markers except wpId, store original opacity for restore
var _savedOpacities = new Map();
function highlightTimelinePin(wpId) {
  state.markerMap.forEach(function(m, id) {
    var el = m.getElement();
    if (!el) return;
    if (id !== wpId) {
      el.style.opacity = '0.3';
    }
  });
}
function clearTimelineHighlight() {
  state.markerMap.forEach(function(m, id) {
    var el = m.getElement();
    if (el) el.style.opacity = '';
  });
}

// ─── Calendar ────────────────────────────────────────────────────────────
window.renderCalendar = renderCalendar;
window.calNav = function(dir) {
  calMonth += dir;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
};

async function renderCalendar() {
  try {
  var grid = document.getElementById('calGrid');
  var label = document.getElementById('calMonthLabel');
  if (!grid) return;
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  label.textContent = months[calMonth] + ' ' + calYear;
  var firstDay = new Date(calYear, calMonth, 1).getDay();
  var daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  var today = new Date();
  var html = '<div class="cal-hdr">Su</div><div class="cal-hdr">Mo</div><div class="cal-hdr">Tu</div><div class="cal-hdr">We</div><div class="cal-hdr">Th</div><div class="cal-hdr">Fr</div><div class="cal-hdr">Sa</div>';
  for (var i = 0; i < firstDay; i++) html += '<div class="cal-day other-month"></div>';
  // Collect all waypoint dates for this month
  var allWaypoints = await db.waypoints.toArray();
  if (state.trip) allWaypoints = allWaypoints.filter(function(wp) { return wp.tripId === state.trip.id; });
  var pinDays = new Set();
  allWaypoints.forEach(function(wp) {
    if (!wp.date) return;
    var d = new Date(wp.date);
    if (d.getFullYear() === calYear && d.getMonth() === calMonth) {
      pinDays.add(d.getDate());
    }
  });
  var trips = await db.trips.toArray();
  for (var d = 1; d <= daysInMonth; d++) {
    var isToday = today.getFullYear() === calYear && today.getMonth() === calMonth && today.getDate() === d;
    var hasTrip = trips.some(function(t) { return t.startDate && new Date(t.startDate).getFullYear() === calYear && new Date(t.startDate).getMonth() === calMonth && new Date(t.startDate).getDate() === d; });
    var hasPin = pinDays.has(d);
    html += '<div class="cal-day' + (isToday ? ' today' : '') + (hasTrip ? ' has-trip' : '') + (hasPin ? ' has-pin' : '') + '" onclick="calDayClick(' + d + ')">' + d + (hasPin ? '<span class="pin-dot"></span>' : '') + '</div>';
  }
  grid.innerHTML = html;
  } catch(e) { console.warn('renderCalendar error:', e); } }

window.calDayClick = async function(day) {
  var detail = document.getElementById('calDayDetail');
  var dateStr = calYear + '-' + String(calMonth + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  // Toggle: if already showing this day, close it
  if (detail.dataset.open === dateStr) {
    detail.style.display = 'none';
    detail.dataset.open = '';
    return;
  }
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var html = '<div class="cal-day-title">' + months[calMonth] + ' ' + day + ', ' + calYear + '</div>';
  html += '<div class="cal-wp-list">';
  // Filter by current trip if one is active
  var tripFilter = state.trip ? db.waypoints.where('tripId').equals(state.trip.id) : null;
  var pins = await db.waypoints.where('date').equals(dateStr).toArray();
  if (state.trip) pins = pins.filter(function(wp) { return wp.tripId === state.trip.id; });
  if (pins.length) {
    pins.forEach(function(wp) {
      var icon = wp.type === 'flight' ? '\u2708' : wp.type === 'train' ? '\uD83D\uDE8C' : wp.type === 'car' ? '\uD83D\uDE97' : wp.type === 'boat' ? '\uD83D\uDEA2' : '\uD83D\uDCCD';
      html += '<div class="cal-wp" data-wp-id="' + wp.id + '">' +
        '<span style="font-size:1rem">' + icon + '</span>' +
        '<span class="cal-wp-name">' + escHtml(wp.name || 'Pin') + '</span>' +
        '<span class="cal-wp-type">' + (wp.type||'pin') + '</span></div>';
    });
  } else {
    html += '<div style="padding:16px 12px;font-size:0.8rem;color:var(--fg-muted);text-align:center">No pins on this day.</div>';
  }
  html += '</div>';
  detail.innerHTML = html;
  detail.style.display = '';
  detail.dataset.open = dateStr;
  // Wire up clicks
  detail.querySelectorAll('.cal-wp[data-wp-id]').forEach(function(el) {
    el.onclick = function() {
      var id = parseInt(el.dataset.wpId);
      var m = state.markerMap.get(id);
      if (m) { map.setView(m.getLatLng(), 16); }
      if (window.handleWaypointClick) window.handleWaypointClick(id, m);
      detail.style.display = 'none';
      detail.dataset.open = '';
    };
  });
};

// ─── Trash ───────────────────────────────────────────────────────────────
async function loadTrash() {
  var cutoff = Date.now() - TRASH_DAYS * 86400000;
  var items = await db.trips.where('status').equals('trash').toArray();
  var recent = items.filter(function(t) { return !t.deletedAt || t.deletedAt > cutoff; });
  var list = document.getElementById('trashList');
  if (!recent.length) { list.innerHTML = '<p style="padding:16px;font-size:0.8rem;color:var(--fg-muted)">Trash is empty.</p>'; return; }
  list.innerHTML = '';
  recent.forEach(function(t) {
    var div = document.createElement('div');
    div.className = 'trash-item';
    var deleted = t.deletedAt ? new Date(t.deletedAt).toLocaleDateString() : 'Unknown';
    div.innerHTML = '<div class="trash-item-info"><div class="trash-name">' + escHtml(t.name) + '</div><div class="trash-time">Deleted ' + deleted + '</div></div>' +
      '<div style="display:flex;gap:6px"><button class="trash-restore" onclick="restoreTrashItem(' + t.id + ')">Restore</button><button class="trash-perma" onclick="permaDeleteTrash(' + t.id + ')">Delete</button></div>';
    list.appendChild(div);
  });
}

async function updateTrashBadge() {
  var cutoff = Date.now() - TRASH_DAYS * 86400000;
  var items = await db.trips.where('status').equals('trash').toArray();
  var count = items.filter(function(t) { return !t.deletedAt || t.deletedAt > cutoff; }).length;
  var badge = document.getElementById('trashBadge');
  if (badge) { badge.textContent = count; badge.style.display = count ? '' : 'none'; }
}

window.restoreTrashItem = async function(id) { await db.trips.update(id, { status: 'planning', deletedAt: null }); await loadTrash(); await updateTrashBadge(); };

window.permaDeleteTrash = async function(id) {
  if (!confirm('Permanently delete this trip?')) return;
  await db.trips.delete(id);
  await db.waypoints.where('tripId').equals(id).delete();
  await loadTrash();
  await updateTrashBadge();
};

window.emptyTrashAll = async function() {
  var cutoff = Date.now() - TRASH_DAYS * 86400000;
  var items = await db.trips.where('status').equals('trash').toArray();
  for (var i = 0; i < items.length; i++) {
    var t = items[i];
    if (!t.deletedAt || t.deletedAt <= cutoff) {
      await db.trips.delete(t.id);
      await db.waypoints.where('tripId').equals(t.id).delete();
    }
  }
  await loadTrash();
  await updateTrashBadge();
};

function startTrashSweep() {
  setInterval(async function() {
    var cutoff = Date.now() - TRASH_DAYS * 86400000;
    var items = await db.trips.where('status').equals('trash').toArray();
    for (var i = 0; i < items.length; i++) {
      var t = items[i];
      if (!t.deletedAt || t.deletedAt <= cutoff) {
        await db.trips.delete(t.id);
        await db.waypoints.where('tripId').equals(t.id).delete();
      }
    }
    await updateTrashBadge();
  }, 3600000);
}


// ─── Search ─────────────────────────────────────────────────────────────
var gsInput = document.getElementById('globalSearch');
if (gsInput) {
  gsInput.addEventListener('input', debounce(searchAll, 200));
  gsInput.addEventListener('focus', function() { var r = document.getElementById('searchResults'); if (r && r.children.length) r.classList.add('open'); });
}

async function searchAll(query) {
  var results = document.getElementById('searchResults');
  var clearBtn = document.getElementById('searchClear');
  if (!query || query.length < 2) { results.innerHTML = ''; results.classList.remove('open'); if (clearBtn) clearBtn.style.display = 'none'; return; }
  if (clearBtn) clearBtn.style.display = '';
  var q = query.toLowerCase();
  var allTrips = await db.trips.toArray();
  var matchingTrips = allTrips.filter(function(t) { return t.name && t.name.toLowerCase().indexOf(q) !== -1; });
  var allWps = await db.waypoints.toArray();
  var matchingWps = allWps.filter(function(w) { return (w.name||'').toLowerCase().indexOf(q) !== -1 || (w.tags||'').toLowerCase().indexOf(q) !== -1; });
  var html = '';
  matchingTrips.slice(0, 5).forEach(function(t) { html += '<div class="sr-item" onclick="openTripFromSearch(' + t.id + ')"><div class="sr-name">&#128205; ' + escHtml(t.name) + '</div><div class="sr-meta">Trip</div></div>'; });
  matchingWps.slice(0, 5).forEach(function(wp) { html += '<div class="sr-item" onclick="openWpFromSearch(' + wp.id + ')"><div class="sr-name">&#128205; ' + escHtml(wp.name || 'Unnamed') + '</div><div class="sr-meta">' + escHtml(wp.tripName || 'Unknown trip') + '</div></div>'; });
  if (!html) html = '<div class="sr-item"><div class="sr-name">No results</div></div>';
  results.innerHTML = html;
  results.classList.add('open');
}

window.clearSearch = function() {
  var s = document.getElementById('globalSearch');
  var r = document.getElementById('searchResults');
  var c = document.getElementById('searchClear');
  if (s) s.value = '';
  if (r) { r.innerHTML = ''; r.classList.remove('open'); }
  if (c) c.style.display = 'none';
};

window.openTripFromSearch = async function(id) { closeSidebar(); await selectTrip(id); };

window.openWpFromSearch = async function(id) {
  var wp = await db.waypoints.get(id);
  if (!wp) return;
  if (wp.tripId) await selectTrip(wp.tripId);
  map.setView([wp.lat, wp.lng], 15);
  var sr = document.getElementById('searchResults');
  if (sr) sr.classList.remove('open');
  clearSearch();
};

window.toggleSidebar = function() {
  var sb = document.getElementById('sidebar');
  var isMobile = window.innerWidth <= 768;
  if (isMobile) {
    // Mobile: toggle the .open class (positioned fixed overlay)
    sb.classList.toggle('open');
  } else {
    // Desktop: hide/show inline — remove inline style to restore CSS, or set to none
    if (sb.dataset.hidden === '1') {
      sb.dataset.hidden = '0';
      sb.style.display = '';
    } else {
      sb.dataset.hidden = '1';
      sb.style.display = 'none';
    }
  }
  if (window.map) map.invalidateSize();
};

window.closeSidebar = function() { document.getElementById('sidebar').style.display = 'none'; map.invalidateSize(); };

// ─── Share ────────────────────────────────────────────────────────────────
window.shareCurrentTrip = async function() {
  if (!state.trip) { alert('Open a trip first'); return; }
  var wps = await db.waypoints.where('tripId').equals(state.trip.id).toArray();
  var strings = await db.strings.where('tripId').equals(state.trip.id).toArray();
  var tripData = Object.assign({}, state.trip, { waypoints: wps, strings });
  var result = await shareTrip(tripData);
  var sc = document.getElementById('shareContent');
  sc.innerHTML = '<p style="font-size:0.8rem;color:var(--fg-muted);margin-bottom:12px">Share this link:</p>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
    '<input type="text" readonly value="' + result.url + '" id="shareUrl" style="flex:1;background:var(--bg-base);border:1px solid var(--border);border-radius:8px;padding:8px;color:var(--fg);font-size:0.8rem">' +
    '<button class="btn btn-primary" onclick="copyShareUrl()">Copy</button></div>' +
    (result.password ? '<p style="font-size:0.75rem;color:var(--accent);margin-top:8px">Password protected.</p>' : '');
  openModal('shareModal');
};

window.copyShareUrl = function() {
  navigator.clipboard.writeText(document.getElementById('shareUrl').value).then(function() { alert('Copied!'); }).catch(function() { alert('Copy failed'); });
};

window.openShareModal = function() { if (!state.trip) { alert('Open a trip first'); return; } shareCurrentTrip(); };

window.shareViaNostrPrompt = async function() {
  if (!window.nostr) { alert('NIP-07 extension needed for Nostr sharing'); return; }
  if (!state.trip) { alert('Open a trip first'); return; }
  var wps = await db.waypoints.where('tripId').equals(state.trip.id).toArray();
  var strings = await db.strings.where('tripId').equals(state.trip.id).toArray();
  var result = await shareViaNostr(Object.assign({}, state.trip, { waypoints: wps, strings }));
  alert('Shared to Nostr! ID: ' + (result.id || 'ok'));
};

// ─── Sync ─────────────────────────────────────────────────────────────────
window.selectSyncFolder = async function() {
  var result = await requestSyncFolder();
  if (result.error) { document.getElementById('syncFolderStatus').textContent = 'Error: ' + result.error; return; }
  if (result.cancelled) return;
  document.getElementById('syncFolderStatus').textContent = 'Folder: ' + (result.folderName || 'Selected');
  document.getElementById('syncLabel').textContent = result.folderName || 'Syncing';
  document.getElementById('syncBtn').classList.add('connected');
};

window.updateSyncStatus = function() {
  var status = getSyncStatus();
  var label = document.getElementById('syncLabel');
  if (label) {
    label.textContent = status.enabled ? (status.folderName || 'Syncing') : 'Local';
    document.getElementById('syncBtn').classList.toggle('connected', status.enabled);
  }
};

window.openSyncModal = function() { openModal('settingsModal'); };

// ─── Explore ──────────────────────────────────────────────────────────────
window.doExplore = async function(lat, lng) {
  document.getElementById('exploreBar').style.display = 'flex';
  var results = document.getElementById('exploreResults');
  results.innerHTML = '<p style="font-size:0.8rem;color:var(--fg-muted);padding:8px">Searching...</p>';
  try {
    var resp = await fetch('https://photon.komoot.io/reverse?lat=' + lat + '&lon=' + lng + '&limit=10');
    var geojson = await resp.json();
    var features = geojson.features || [];
    if (!features.length) { results.innerHTML = '<p class="explore-hint">No places found nearby.</p>'; return; }
    results.innerHTML = '';
    features.slice(0, 8).forEach(function(f) {
      var props = f.properties;
      var name = props.name || 'Unnamed';
      var kind = props.kind || props.type || 'place';
      var icon = getExploreIcon(kind);
      var item = document.createElement('div');
      item.className = 'explore-item';
      item.innerHTML = '<div class="explore-icon">' + icon + '</div>' +
        '<div><div class="explore-name">' + escHtml(name) + '</div><div class="explore-meta">' + escHtml(kind) + '</div></div>' +
        '<button class="btn-sm btn-ghost" style="margin-left:auto" onclick="saveExplorePin(' + f.geometry.coordinates[1] + ',' + f.geometry.coordinates[0] + ',' + encodeURIComponent(name) + ',' + encodeURIComponent(kind) + ')">+</button>';
      results.appendChild(item);
    });
  } catch(e) { results.innerHTML = '<p class="explore-hint">Search failed.</p>'; console.error(e); }
};

function getExploreIcon(type) {
  var t = (type || '').toLowerCase();
  if (t.indexOf('restaurant') !== -1 || t.indexOf('food') !== -1) return '&#127869;';
  if (t.indexOf('hotel') !== -1 || t.indexOf('hostel') !== -1) return '&#128719;';
  if (t.indexOf('museum') !== -1) return '&#128181;';
  if (t.indexOf('park') !== -1 || t.indexOf('garden') !== -1) return '&#128991;';
  if (t.indexOf('beach') !== -1) return '&#128991;';
  if (t.indexOf('church') !== -1 || t.indexOf('temple') !== -1) return '&#9962;';
  if (t.indexOf('shop') !== -1 || t.indexOf('mall') !== -1) return '&#128717;';
  if (t.indexOf('bar') !== -1) return '&#127942;';
  if (t.indexOf('mountain') !== -1) return '&#127956;';
  if (t.indexOf('airport') !== -1) return '&#9992;';
  if (t.indexOf('station') !== -1 || t.indexOf('train') !== -1) return '&#128646;';
  return '&#128205;';
}

window.saveExplorePin = async function(lat, lng, name, kind) {
  if (typeof name === 'string') name = decodeURIComponent(name);
  if (typeof kind === 'string') kind = decodeURIComponent(kind);
  if (!state.trip) {
    var id = await db.trips.add({ name: 'My Trip', status: 'planning', created: Date.now(), color: '#6366f1' });
    state.trip = await db.trips.get(id);
  }
  await addWaypoint([lat, lng], {
    name: name, type: kind, status: 'saved',
    tripId: state.trip.id, tripName: state.trip.name,
    date: new Date().toISOString().slice(0, 10)
  });
  closeFAB();
};

// ─── Undo ────────────────────────────────────────────────────────────────
var undoStack = (function() {
  try { return JSON.parse(localStorage.getItem('tm_undo') || '[]'); } catch { return []; }
})();

window.pushUndo = function(action, data) {
  undoStack.push({ action: action, data: data, ts: Date.now() });
  if (undoStack.length > 20) undoStack.shift();
  try { localStorage.setItem('tm_undo', JSON.stringify(undoStack)); } catch {}
};

window.undoLast = async function() {
  var action = undoStack.pop();
  if (!action) return;
  try { localStorage.setItem('tm_undo', JSON.stringify(undoStack)); } catch {}
  if (action.action === 'delete_trip') await db.trips.add(action.data);
  else if (action.action === 'delete_wp') await db.waypoints.add(action.data);
  await loadTrips();
};

// ─── Modal helpers ────────────────────────────────────────────────────────
window.openModal = function(id) {
  var m = document.getElementById(id);
  if (!m) return;
  m.classList.add('is-open');
  m.style.display = 'flex';
};

window.closeModal = function(id) {
  var m = document.getElementById(id);
  if (!m) return;
  m.classList.remove('is-open');
  m.style.display = 'none';
};

// ─── Shared trip check ────────────────────────────────────────────────────
async function checkSharedTrip() {
  var hash = window.location.hash;
  if (!hash.startsWith('#share=') && !hash.startsWith('#view=')) return;
  var result = await loadSharedTrip(hash.slice(1));
  if (!result || !result.encryptedData) return;
  var pw = result.needsPassword || !result.source ? prompt('Password (if set):') || null : null;
  var trip = await decryptTrip(result.encryptedData, pw);
  if (!trip) return;
  document.getElementById('map').style.display = 'none';
  document.getElementById('sidebar').style.display = 'none';
  document.getElementById('tripBanner').style.display = '';
  document.getElementById('tripBannerName').textContent = (trip.name || 'Trip') + ' (view only)';
  document.getElementById('tripBannerStats').textContent = (trip.waypoints ? trip.waypoints.length : 0) === 1 ? '1 pin' : (trip.waypoints ? trip.waypoints.length : 0) + ' pins';
}

// ─── Export / Import ───────────────────────────────────────────────────────
window.exportAllTrips = async function() {
  var trips = await db.trips.toArray();
  for (var i = 0; i < trips.length; i++) {
    trips[i].waypoints = await db.waypoints.where('tripId').equals(trips[i].id).toArray();
    trips[i].strings = await db.strings.where('tripId').equals(trips[i].id).toArray();
  }
  var json = JSON.stringify({ version: 2, exportedAt: Date.now(), trips: trips }, null, 2);
  var blob = new Blob([json], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'threadmaps-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
};

window.importTripsFromFile = async function(event) {
  var file = event.target.files[0];
  if (!file) return;
  var text = await file.text();
  try {
    var data = JSON.parse(text);
    var trips = Array.isArray(data) ? data : (data.trips || []);
    var count = 0;
    for (var i = 0; i < trips.length; i++) {
      var t = trips[i];
      var wps = t.waypoints || [];
      var strs = t.strings || [];
      delete t.waypoints;
      delete t.strings;
      var id = await db.trips.add(t);
      for (var j = 0; j < wps.length; j++) { wps[j].tripId = id; await db.waypoints.add(wps[j]); }
      for (var k = 0; k < strs.length; k++) { strs[k].tripId = id; await db.strings.add(strs[k]); }
      count++;
    }
    await loadTrips();
    alert('Imported ' + count + ' trip' + (count !== 1 ? 's' : '') + '!');
  } catch(e) { alert('Import failed: ' + e.message); }
};

window.openSettings = function() { openModal('settingsModal'); };

window.selectPhotoFolder = async function() {
  var result = await requestPhotoFolder();
  if (result.error) { alert('Error: ' + result.error); return; }
  if (!result.cancelled) alert('Photo folder set!');
};

// ─── Utilities ────────────────────────────────────────────────────────────
function escHtml(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function debounce(fn, ms) { var t; return function() { var args = arguments; clearTimeout(t); t = setTimeout(function() { fn.apply(null, args); }, ms); }; }

// ─── Waypoint modal ───────────────────────────────────────────────────────
// ─── Pin Connection (Travel) ─────────────────────────────────────────────
var connectingFromId = null;  // pin we're connecting FROM
var connectingResolve = null; // promise resolver for mode selection

window.selectTravelMode = function(mode) {
  if (connectingResolve) { connectingResolve(mode); connectingResolve = null; }
  closeModal('travelModal');
};

// Override showModeSelector from main.js to use our modal
window.showModeSelector = function() {
  return new Promise(function(resolve) {
    connectingResolve = resolve;
    openModal('travelModal');
  });
};

window.startConnectPin = function() {
  // Set the currently open waypoint as the "from" pin, then wait for another tap
  var wpId = document.getElementById('wpId') ? parseInt(document.getElementById('wpId').value) : null;
  if (!wpId) return;
  connectingFromId = wpId;
  closeModal('waypointModal');
  // Show a toast / banner
  var banner = document.createElement('div');
  banner.id = 'connectBanner';
  banner.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;padding:10px 20px;border-radius:8px;z-index:500;font-size:0.9rem;pointer-events:none';
  banner.textContent = 'Now tap another pin to connect it';
  document.body.appendChild(banner);
};

// Hook into handleWaypointClick to detect connect mode
var _origHandleClick = window.handleWaypointClick;
window.handleWaypointClick = async function(id, marker) {
  var banner = document.getElementById('connectBanner');
  if (connectingFromId && connectingFromId !== id) {
    if (banner) banner.remove();
    // Ask travel mode
    var mode = await window.showModeSelector();
    if (mode && typeof connectWaypoints === 'function') {
      await connectWaypoints(connectingFromId, id, mode);
    } else if (mode && window.db && window.state && window.state.trip) {
      await window.db.strings.add({ tripId: window.state.trip.id, fromId: connectingFromId, toId: id, mode: mode, geometry: null });
      renderStrings();
    }
    connectingFromId = null;
    return;
  }
  if (banner) banner.remove();
  connectingFromId = null;
  if (_origHandleClick) return _origHandleClick(id, marker);
};

window.openWaypointModal = function(lat, lng, wp) {
  wp = wp || null;
  // Default new pins to today's date (ISO yyyy-mm-dd)
  var today = new Date();
  var todayIso = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  document.getElementById('waypointModalTitle').textContent = wp ? 'Edit Pin' : 'Add Pin';
  var connectBtn = document.getElementById('wpConnectBtn');
  if (connectBtn) connectBtn.style.display = (wp && wp.id) ? '' : 'none';
  if (wp && wp.id) {
    var wpIdEl = document.getElementById('wpId');
    if (!wpIdEl) {
      wpIdEl = document.createElement('input');
      wpIdEl.type = 'hidden';
      wpIdEl.id = 'wpId';
      document.getElementById('waypointModal').appendChild(wpIdEl);
    }
    wpIdEl.value = wp.id;
  }
  document.getElementById('wpName').value = wp ? (wp.name || '') : '';
  document.getElementById('wpType').value = wp ? (wp.type || 'pin') : 'pin';
  document.getElementById('wpTags').value = wp ? (wp.tags || '') : '';
  document.getElementById('wpDate').value = wp ? (wp.date || todayIso) : todayIso;
  document.getElementById('wpNotes').value = wp ? (wp.notes || '') : '';
  document.getElementById('wpLat').value = lat;
  document.getElementById('wpLng').value = lng;
  document.getElementById('wpEditId').value = wp ? wp.id : '';
  openModal('waypointModal');
};

window.saveWaypointModal = async function() {
  var name = document.getElementById('wpName').value.trim();
  var lat = parseFloat(document.getElementById('wpLat').value);
  var lng = parseFloat(document.getElementById('wpLng').value);
  var editId = document.getElementById('wpEditId').value;
  if (!name) { alert('Name required'); return; }
  if (!state.trip) {
    // Auto-create a trip
    var id = await db.trips.add({ name: 'My Trip', status: 'planning', created: Date.now(), color: '#6366f1' });
    state.trip = await db.trips.get(id);
  }
  var wpData = {
    tripId: state.trip.id,
    tripName: state.trip.name,
    lat: lat,
    lng: lng,
    name: name,
    type: document.getElementById('wpType').value,
    tags: document.getElementById('wpTags').value.trim(),
    date: document.getElementById('wpDate').value,
    notes: document.getElementById('wpNotes').value.trim(),
    color: state.trip.color || '#6366f1',
    status: 'active'
  };
  if (editId) {
    await db.waypoints.update(parseInt(editId), wpData);
  } else {
    wpData.created = Date.now();
    var wpId = await db.waypoints.add(wpData);
    wpData.id = wpId;
  }
  closeModal('waypointModal');
  // Add pin to map if not editing
  if (!editId) {
    await addWaypointToMap(lat, lng, wpData);
  } else if (editId) {
    // Reload waypoint
    var m = state.markerMap.get(parseInt(editId));
    if (m) { m.setLatLng([lat, lng]); }
  }
  document.getElementById('tripBannerStats').textContent = (state.waypoints.size === 1 ? '1 pin' : state.waypoints.size + ' pins');
  document.getElementById('timeline').style.display = state.waypoints.size > 1 ? '' : 'none';
  document.getElementById('timelineControls').style.display = state.waypoints.size > 1 ? '' : 'none';
  renderTimeline();
};

async function addWaypointToMap(lat, lng, wpData) {
  var wpId = wpData.id;
  state.waypoints.set(wpId, wpData);
  var icon = (typeof window.makePinIcon === 'function') ? window.makePinIcon(wpData) : undefined;
  var m = L.marker([lat, lng], icon ? { icon: icon } : {}).addTo(map);
  m.on('click', function() { handleWaypointClick(wpId, m); });
  m.on('contextmenu', function(e) { L.DomEvent.stopPropagation(e); showWaypointDetails(wpId); });
  state.markers.set(wpId, m);
  state.markerMap.set(wpId, m);
  if (state.waypoints.size === 1) {
    map.setView([lat, lng], 12);
  }
}

window.showWaypointDetails = async function(wpId) {
  var wp = await db.waypoints.get(wpId);
  if (!wp) return;
  openWaypointModal(wp.lat, wp.lng, wp);
};

window.deleteWaypoint = async function(wpId) {
  if (!confirm('Delete this pin?')) return;
  pushUndo('delete_wp', await db.waypoints.get(wpId));
  await db.waypoints.delete(wpId);
  var m = state.markerMap.get(wpId);
  if (m) { m.remove(); state.markers.delete(wpId); state.markerMap.delete(wpId); }
  state.waypoints.delete(wpId);
  state.selectedWaypoint = null;
  document.getElementById('tripBannerStats').textContent = (state.waypoints.size === 1 ? '1 pin' : state.waypoints.size + ' pins');
  document.getElementById('timeline').style.display = state.waypoints.size > 1 ? '' : 'none';
  renderTimeline();
};
