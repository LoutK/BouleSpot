const config = window.APP_CONFIG || {};
const SUPABASE_URL = config.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = config.SUPABASE_ANON_KEY || "";
const supabaseClient = (window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY)
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const map = L.map("map", { zoomControl: true }).setView([52.1326, 5.2913], 7);
const markerCluster = L.markerClusterGroup({ disableClusteringAtZoom: 14 });
const markersById = new Map();

// Basemaps
const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
});

// Luchtfoto met labels via Esri World Imagery + Boundary overlay
const aerialLayer = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, attribution: "Tiles &copy; Esri" }
);
const aerialLabels = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, opacity: 1 }
);
const aerialWithLabels = L.layerGroup([aerialLayer, aerialLabels]);

let isAerial = false;
streetLayer.addTo(map);
map.addLayer(markerCluster);

// ── Layer toggle (proper Leaflet control — prevents click propagation to map) ─
const LayerToggleControl = L.Control.extend({
  options: { position: "bottomright" },
  onAdd(map) {
    const btn = L.DomUtil.create("div", "layer-toggle");
    btn.title = "Wissel basemap";
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.disableScrollPropagation(btn);

    const img = L.DomUtil.create("img", "layer-toggle-thumb", btn);
    img.src = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/5/10/16";
    img.alt = "";

    const lbl = L.DomUtil.create("span", "layer-toggle-label", btn);
    lbl.textContent = "Luchtfoto";

    L.DomEvent.on(btn, "click", () => {
      if (isAerial) {
        map.removeLayer(aerialWithLabels);
        streetLayer.addTo(map);
        img.src = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/5/10/16";
        lbl.textContent = "Luchtfoto";
        isAerial = false;
      } else {
        map.removeLayer(streetLayer);
        aerialWithLabels.addTo(map);
        img.src = "https://a.tile.openstreetmap.org/5/16/10.png";
        lbl.textContent = "Kaart";
        isAerial = true;
      }
    });

    return btn;
  },
});
new LayerToggleControl().addTo(map);

const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");

let totalLocations = 0;
let userAddedCount = 0;
let ratings = {};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeLocation(raw) {
  return {
    id: String(raw.id),
    name: String(raw.name || "Onbekende baan"),
    lat: Number(raw.lat),
    lon: Number(raw.lon),
    source: String(raw.source || "Onbekend"),
  };
}

function setStatus(message, isError = false) {
  const bar = document.getElementById("status-bar");
  statusEl.textContent = message;
  bar.hidden = !message;
  bar.classList.toggle("error", isError);
}

function updateMeta() {
  metaEl.textContent =
    `${totalLocations} locaties op de kaart (waarvan ${userAddedCount} door gebruikers toegevoegd). ` +
    `Bron: OpenStreetMap / Supabase.`;
}

function aggregateRatings(rows) {
  const output = {};
  for (const row of rows) {
    const key = String(row.location_id);
    if (!output[key]) {
      output[key] = {
        locationTotal: 0,
        locationVotes: 0,
        atmosphereTotal: 0,
        atmosphereVotes: 0,
      };
    }
    if (Number.isInteger(row.location_score)) {
      output[key].locationTotal += row.location_score;
      output[key].locationVotes += 1;
    }
    if (Number.isInteger(row.atmosphere_score)) {
      output[key].atmosphereTotal += row.atmosphere_score;
      output[key].atmosphereVotes += 1;
    }
  }
  return output;
}

function getRatingSummary(locationId) {
  const raw = ratings[locationId];
  if (!raw) {
    return {
      locationAverage: null,
      locationVotes: 0,
      atmosphereAverage: null,
      atmosphereVotes: 0,
    };
  }
  return {
    locationAverage: raw.locationVotes ? raw.locationTotal / raw.locationVotes : null,
    locationVotes: raw.locationVotes,
    atmosphereAverage: raw.atmosphereVotes ? raw.atmosphereTotal / raw.atmosphereVotes : null,
    atmosphereVotes: raw.atmosphereVotes,
  };
}

function applyLocalRating(locationId, locationScore, atmosphereScore) {
  const current = ratings[locationId] || {
    locationTotal: 0,
    locationVotes: 0,
    atmosphereTotal: 0,
    atmosphereVotes: 0,
  };
  if (Number.isInteger(locationScore)) {
    current.locationTotal += locationScore;
    current.locationVotes += 1;
  }
  if (Number.isInteger(atmosphereScore)) {
    current.atmosphereTotal += atmosphereScore;
    current.atmosphereVotes += 1;
  }
  ratings[locationId] = current;
}

function ratingText(avg, votes) {
  return votes ? `${avg.toFixed(1)}/5 (${votes} stemmen)` : "Nog geen stemmen";
}

function buildPopupContent(location) {
  const summary = getRatingSummary(location.id);
  const source = location.source ? `<div class="popup-source">${escapeHtml(location.source)}</div>` : "";

  return `
    <div class="popup-inner">
      <h3>${escapeHtml(location.name)}</h3>
      ${source}
      <div class="popup-rating">
        <div><strong>Locatie:</strong> ${ratingText(summary.locationAverage, summary.locationVotes)}</div>
        <div><strong>Sfeer:</strong> ${ratingText(summary.atmosphereAverage, summary.atmosphereVotes)}</div>
      </div>
      <form class="popup-form" data-location-id="${escapeHtml(location.id)}">
        <label>Score locatie</label>
        <select name="locationScore">
          <option value="">—</option>
          <option value="1">1 – Slecht</option>
          <option value="2">2 – Matig</option>
          <option value="3">3 – Oké</option>
          <option value="4">4 – Goed</option>
          <option value="5">5 – Uitstekend</option>
        </select>
        <label>Score sfeer</label>
        <select name="atmosphereScore">
          <option value="">—</option>
          <option value="1">1 – Slecht</option>
          <option value="2">2 – Matig</option>
          <option value="3">3 – Oké</option>
          <option value="4">4 – Goed</option>
          <option value="5">5 – Uitstekend</option>
        </select>
        <button type="submit">Rating opslaan</button>
      </form>
    </div>
  `;
}

function ensureMarker(location) {
  const existing = markersById.get(location.id);
  if (existing) {
    existing.locationRef = location;
    existing.setPopupContent(buildPopupContent(location));
    return;
  }
  const marker = L.marker([location.lat, location.lon], { title: location.name });
  marker.locationRef = location;
  marker.bindPopup(buildPopupContent(location));
  markersById.set(location.id, marker);
  markerCluster.addLayer(marker);
}

function refreshAllPopups() {
  for (const marker of markersById.values()) {
    marker.setPopupContent(buildPopupContent(marker.locationRef));
  }
}

function buildAddLocationPopup(latlng) {
  return `
    <div class="popup-inner">
      <h3>Baan toevoegen</h3>
      <form class="map-add-form">
        <label>Naam van de baan *</label>
        <input name="name" maxlength="120" required placeholder="bijv. Petanque Brasserie du Parc">
        <label>Score locatie (optioneel)</label>
        <select name="newLocationRating">
          <option value="">—</option>
          <option value="1">1 – Slecht</option>
          <option value="2">2 – Matig</option>
          <option value="3">3 – Oké</option>
          <option value="4">4 – Goed</option>
          <option value="5">5 – Uitstekend</option>
        </select>
        <label>Score sfeer (optioneel)</label>
        <select name="newAtmosphereRating">
          <option value="">—</option>
          <option value="1">1 – Slecht</option>
          <option value="2">2 – Matig</option>
          <option value="3">3 – Oké</option>
          <option value="4">4 – Goed</option>
          <option value="5">5 – Uitstekend</option>
        </select>
        <button type="submit">Opslaan</button>
        <input type="hidden" name="lat" value="${latlng.lat.toFixed(6)}">
        <input type="hidden" name="lon" value="${latlng.lng.toFixed(6)}">
      </form>
    </div>
  `;
}

async function loadAllLocations() {
  if (!supabaseClient) throw new Error("Supabase niet geconfigureerd.");
  const PAGE = 1000;
  let page = 0;
  let allLocations = [];
  while (true) {
    const { data, error } = await supabaseClient
      .from("user_locations")
      .select("id,name,lat,lon,source")
      .order("created_at", { ascending: true })
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) throw error;
    allLocations = allLocations.concat(data || []);
    if (!data || data.length < PAGE) break;
    page++;
  }
  return allLocations;
}

async function syncSharedData() {
  if (!supabaseClient) return;

  const [allLocations, ratingsResponse] = await Promise.all([
    loadAllLocations(),
    supabaseClient
      .from("ratings")
      .select("location_id,location_score,atmosphere_score")
      .order("id", { ascending: true }),
  ]);

  if (ratingsResponse.error) throw ratingsResponse.error;

  ratings = aggregateRatings(ratingsResponse.data || []);
  allLocations.map(normalizeLocation).forEach(ensureMarker);
  refreshAllPopups();

  totalLocations = allLocations.length;
  userAddedCount = allLocations.filter(l => l.source === "Gebruiker").length;
  updateMeta();
}

async function addUserLocation(formData) {
  const lat = Number(formData.get("lat"));
  const lon = Number(formData.get("lon"));
  const name = String(formData.get("name") || "").trim();

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !name) {
    setStatus("Kon locatie niet toevoegen: ongeldige invoer.", true);
    return;
  }

  const location = normalizeLocation({
    id: `user-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
    name,
    lat,
    lon,
    source: "Gebruiker",
  });

  if (supabaseClient) {
    const { error } = await supabaseClient.from("user_locations").insert({
      id: location.id,
      name: location.name,
      lat: location.lat,
      lon: location.lon,
      source: location.source,
    });
    if (error) {
      setStatus(`Opslaan mislukt: ${error.message}`, true);
      return;
    }
  } else {
    setStatus("Supabase niet geconfigureerd; locatie niet opgeslagen.", true);
    return;
  }

  ensureMarker(location);
  updateMeta();

  const locationScore = Number(formData.get("newLocationRating"));
  const atmosphereScore = Number(formData.get("newAtmosphereRating"));
  const hasLocation = Number.isInteger(locationScore) && locationScore >= 1 && locationScore <= 5;
  const hasAtmosphere = Number.isInteger(atmosphereScore) && atmosphereScore >= 1 && atmosphereScore <= 5;
  if (hasLocation || hasAtmosphere) {
    await submitRating(location.id, hasLocation ? locationScore : null, hasAtmosphere ? atmosphereScore : null);
  }

  setStatus("Nieuwe locatie toegevoegd.");
  map.setView([location.lat, location.lon], 14);
}

async function submitRating(locationId, locationScore, atmosphereScore) {
  if (!Number.isInteger(locationScore) && !Number.isInteger(atmosphereScore)) {
    setStatus("Geef minimaal een score voor locatie of sfeer.", true);
    return;
  }

  if (supabaseClient) {
    const { error } = await supabaseClient.from("ratings").insert({
      location_id: locationId,
      location_score: Number.isInteger(locationScore) ? locationScore : null,
      atmosphere_score: Number.isInteger(atmosphereScore) ? atmosphereScore : null,
    });
    if (error) {
      setStatus(`Rating opslaan mislukt: ${error.message}`, true);
      return;
    }
  } else {
    applyLocalRating(locationId, locationScore, atmosphereScore);
  }

  applyLocalRating(locationId, locationScore, atmosphereScore);
  refreshAllPopups();
  setStatus("Rating opgeslagen.");
}

map.on("click", (event) => {
  L.popup()
    .setLatLng(event.latlng)
    .setContent(buildAddLocationPopup(event.latlng))
    .openOn(map);
});

document.addEventListener("submit", async (event) => {
  const ratingForm = event.target.closest(".popup-form");
  if (ratingForm) {
    event.preventDefault();
    const formData = new FormData(ratingForm);
    const locationId = ratingForm.dataset.locationId;
    const locationScore = Number(formData.get("locationScore"));
    const atmosphereScore = Number(formData.get("atmosphereScore"));
    const hasLocation = Number.isInteger(locationScore) && locationScore >= 1 && locationScore <= 5;
    const hasAtmosphere = Number.isInteger(atmosphereScore) && atmosphereScore >= 1 && atmosphereScore <= 5;
    await submitRating(locationId, hasLocation ? locationScore : null, hasAtmosphere ? atmosphereScore : null);
    if (supabaseClient) {
      await syncSharedData();
    }
    return;
  }

  const addForm = event.target.closest(".map-add-form");
  if (addForm) {
    event.preventDefault();
    const formData = new FormData(addForm);
    await addUserLocation(formData);
    map.closePopup();
    if (supabaseClient) {
      await syncSharedData();
    }
  }
});

async function bootstrap() {
  if (!supabaseClient) {
    document.getElementById("loading-overlay").classList.add("hidden");
    metaEl.textContent = "";
    setStatus("Kan geen verbinding maken met de database.", true);
    return;
  }

  await syncSharedData();
  document.getElementById("loading-overlay").classList.add("hidden");
  setStatus("");

  window.setInterval(async () => {
    try { await syncSharedData(); } catch (e) { setStatus(`Sync mislukt: ${e.message}`, true); }
  }, 30000);
}

bootstrap().catch((error) => {
  metaEl.textContent = "Fout bij laden van locaties.";
  setStatus(error.message, true);
});
