// api/view.js — Serve the read-only trip viewer
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const url = new URL(req.url);
  const id = url.pathname.split('/view/')[1]?.replace('/', '');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shared Trip — ThreadMaps</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="https://unpkg.com/dexie@3.2.4/dist/dexie.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0a0a0f; color: #fff; height: 100vh; display: flex; flex-direction: column; }
    .header { background: #12121a; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #2a2a3a; flex-shrink: 0; }
    .header .logo { font-size: 1.1rem; font-weight: 800; }
    .header .logo span { color: #6366f1; }
    .header .badge { background: #6366f1; color: #fff; font-size: 0.7rem; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
    #map { flex: 1; }
    .loading { display: flex; align-items: center; justify-content: center; height: 100vh; flex-direction: column; gap: 12px; }
    .spinner { width: 32px; height: 32px; border: 3px solid #2a2a3a; border-top-color: #6366f1; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error { color: #ef4444; text-align: center; padding: 20px; }
    .trip-meta { padding: 12px 16px; background: #12121a; border-top: 1px solid #2a2a3a; }
    .trip-meta h2 { font-size: 1rem; margin-bottom: 4px; }
    .trip-meta p { font-size: 0.8rem; color: #888; }
    .cta { background: #6366f1; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; margin-top: 12px; }
    .pin { display: inline-block; width: 16px; height: 16px; border-radius: 50%; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">Thread<span>Maps</span></div>
    <span class="badge">READ ONLY</span>
  </div>
  <div id="map"></div>
  <div id="meta" class="trip-meta" style="display:none"></div>
  <div id="app" class="loading">
    <div class="spinner"></div>
    <p>Loading shared trip...</p>
  </div>
  <script>
    const MAPBOX_TOKEN = ''; // leave empty for OSM-only
    async function init() {
      const id = window.location.pathname.split('/view/')[1];
      if (!id) { document.getElementById('app').innerHTML = '<div class="error">Invalid link</div>'; return; }
      try {
        const resp = await fetch('/api/share/' + id);
        if (!resp.ok) throw new Error('Trip not found');
        const { encryptedData, meta } = await resp.json();
        let tripData;
        if (encryptedData) {
          // Decrypt client-side with password if set
          const key = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)));
          const iv = Uint8Array.from(atob(encryptedData.split(':')[0]), c => c.charCodeAt(0));
          const ct = Uint8Array.from(atob(encryptedData.split(':')[1]), c => c.charCodeAt(0));
          const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
          tripData = JSON.parse(new TextDecoder().decode(decrypted));
        } else {
          tripData = meta;
        }
        renderTrip(tripData, meta);
      } catch(e) {
        document.getElementById('app').innerHTML = '<div class="error">Could not load trip: ' + e.message + '</div>';
      }
    }
    function renderTrip(trip, meta) {
      document.getElementById('app').style.display = 'none';
      const m = document.getElementById('meta');
      m.style.display = 'block';
      m.innerHTML = '<h2>' + (trip.name || 'Shared Trip') + '</h2><p>' + (trip.waypoints?.length || 0) + ' pins' + (trip.description ? ' · ' + trip.description : '') + '</p><button class="cta" onclick="window.open(\\'https://threadmap.vercel.app\\', \\'_blank\\')">Open in ThreadMaps</button>';
      const map = L.map('map').setView([trip.waypoints?.[0]?.lat || 48.85, trip.waypoints?.[0]?.lng || 2.35], 11);
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png').addTo(map);
      const colors = ['#6366f1','#f59e0b','#10b981','#ef4444','#8b5cf6','#06b6d4'];
      trip.waypoints?.forEach((wp, i) => {
        const color = colors[i % colors.length];
        const marker = L.circleMarker([wp.lat, wp.lng], { radius: 8, color, fillColor: color, fillOpacity: 0.9, weight: 2 }).addTo(map);
        if (wp.name) marker.bindPopup('<b>' + wp.name + '</b>' + (wp.description ? '<br>' + wp.description : ''));
      });
      if (trip.strings) {
        trip.strings.forEach(s => {
          if (s.geometry?.coordinates) {
            const coords = s.geometry.coordinates.map(c => [c[1], c[0]]);
            L.polyline(coords, { color: '#6366f1', weight: 2, dashArray: '4,6' }).addTo(map);
          }
        });
      }
      const bounds = L.latLngBounds(trip.waypoints?.map(w => [w.lat, w.lng]) || []);
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
    }
    init();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=300' }
  });
}
