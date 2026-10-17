// =====================================================================
// app.js — Dashboard Météo Home Assistant + Open-Meteo
// Auteur : BELKACEM Mohamed Amine
// =====================================================================

// ===================== CONFIG =====================
// Token chargé depuis sessionStorage. Si pas trouvé, on demande à l'user.
// JAMAIS en clair dans le code (risque sécu si on commit sur GitHub public)
const TOKEN = (() => {
  let t = sessionStorage.getItem("ha_token");
  if (!t) {
    t = prompt("Colle ton Long-Lived Access Token Home Assistant :") || "";
    if (t) sessionStorage.setItem("ha_token", t);
  }
  return t;
})();

const CONFIG = Object.freeze({
  homeAssistant: {
    location: "zone.home",
    entities: {
      temperature: "sensor.espbonbon_temperature_2",
      humidity:    "sensor.espbonbon_humidite_2",
      pressure:    "sensor.espbonbon_pression_2",
      wind:        "sensor.esp32_weather_vent",
      light:       "sensor.espbonbon_luminosite_2",
      rain:        "sensor.espbonbon_pluviometrie",
    },
  },
  refreshMs: 5000,             // polling capteurs locaux
  weatherRefreshMs: 600000,    // météo externe : toutes les 10 min
  maxChartPoints: 40,          // 40 points au lieu de 20 = meilleur historique visible
  fetchTimeoutMs: 8000,
  fetchRetries: 2,
});

// Headers HTTP créés UNE seule fois et gelés
const AUTH_HEADERS = Object.freeze({
  "Authorization": `Bearer ${TOKEN}`,
  "Content-Type":  "application/json",
});

// ===================== CACHE DOM =====================
const el = Object.freeze({
  temp:  document.getElementById("tempValue"),
  hum:   document.getElementById("humValue"),
  pres:  document.getElementById("presValue"),
  wind:  document.getElementById("windValue"),
  light: document.getElementById("lightValue"),

  rain:  document.getElementById("rainValue"),
  clock: document.getElementById("clock"),
  hint:  document.getElementById("hint"),
  emoji: document.getElementById("emoji"),
  chartTitle: document.getElementById("chartTitle"),
  btnTemperature: document.getElementById("btnTemperature"),
  btnHumidity:    document.getElementById("btnHumidity"),
  btnPressure:    document.getElementById("btnPressure"),
  btnWind:        document.getElementById("btnWind"),
  cityInput:      document.getElementById("cityInput"),
  btnSearchCity:  document.getElementById("btnSearchCity"),
  btnUseHomeLocation: document.getElementById("btnUseHomeLocation"),
  weatherStatus:  document.getElementById("weatherStatus"),
  extCity: document.getElementById("extCity"),
  extDesc: document.getElementById("extDesc"),
  extIcon: document.getElementById("extIcon"),
  extTemp: document.getElementById("extTemp"),
  extFeels: document.getElementById("extFeels"),
  extHum: document.getElementById("extHum"),
  extPres: document.getElementById("extPres"),
  extWind: document.getElementById("extWind"),
  extRain: document.getElementById("extRain"),
});

const CHART_SERIES = Object.freeze({
  temperature: { label: "Température capteur", title: "Variation température capteur", entityKey: "temperature", fallbackUnit: "°C" },
  humidity:    { label: "Humidité capteur",    title: "Variation humidité capteur",    entityKey: "humidity",    fallbackUnit: "%" },
  pressure:    { label: "Pression capteur",    title: "Variation pression capteur",    entityKey: "pressure",    fallbackUnit: "hPa" },
  wind:        { label: "Vent capteur",        title: "Variation vent capteur",        entityKey: "wind",        fallbackUnit: "km/h" },
});

let currentChartKey = "temperature";
let chart = null;
let mapInstance = null;
let marker = null;
let currentExternalCoords = null;
let currentExternalPlaceName = null;
let refreshTimer = null;
let weatherTimer = null;

// Cache du géocoding (clé = ville en minuscules, valeur = coordonnées).
// Comme ça si l'user retape "Paris" 5 fois, on tape l'API qu'UNE seule fois.
const geocodeCache = new Map();

// Historique du chart — persisté dans sessionStorage pour survivre aux refresh
const historyStore = (() => {
  const saved = sessionStorage.getItem("history_store");
  if (saved) {
    try { return JSON.parse(saved); } catch { /* ignore */ }
  }
  return {
    temperature: { labels: [], data: [] },
    humidity:    { labels: [], data: [] },

    pressure:    { labels: [], data: [] },
    wind:        { labels: [], data: [] },
  };
})();

function saveHistory() {
  sessionStorage.setItem("history_store", JSON.stringify(historyStore));
}

// ===================== EMOJIS =====================
function getTemperatureEmoji(value) {
  if (value >= 30) return "🥵";
  if (value >= 18) return "😎";
  if (value >= 14) return "🙂";
  if (value >= 4)  return "🥶";
  return "❄️";
}

function getWeatherEmoji(code) {
  if (code === 0) return "☀️";
  if (code === 1) return "🌤️";
  if (code === 2) return "⛅";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51,53,55,56,57,61,63,65,80,81,82].includes(code)) return "🌧️";
  if ([66, 67].includes(code)) return "🌨️";
  if ([71,73,75,77,85,86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌤️";
}

const WEATHER_DESCRIPTIONS = Object.freeze({
  0:"Ciel dégagé", 1:"Plutôt dégagé", 2:"Partiellement nuageux", 3:"Couvert",
  45:"Brouillard", 48:"Brouillard givrant",
  51:"Bruine légère", 53:"Bruine modérée", 55:"Bruine dense",
  56:"Bruine verglaçante légère", 57:"Bruine verglaçante dense",
  61:"Pluie faible", 63:"Pluie modérée", 65:"Pluie forte",
  66:"Pluie verglaçante légère", 67:"Pluie verglaçante forte",
  71:"Neige faible", 73:"Neige modérée", 75:"Neige forte", 77:"Grains de neige",
  80:"Averses faibles", 81:"Averses modérées", 82:"Averses fortes",
  85:"Averses de neige faibles", 86:"Averses de neige fortes",
  95:"Orage", 96:"Orage avec grêle légère", 99:"Orage avec forte grêle",
});

function weatherDescriptionFr(code) {
  return WEATHER_DESCRIPTIONS[code] || "Conditions météo inconnues";
}

// ===================== HORLOGE (alignée sur la seconde) =====================
function startClock() {
  const tick = () => {
    const d = new Date();

    el.clock.textContent =
 `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
    // Aligné pile sur la prochaine seconde → pas de dérive
    setTimeout(tick, 1000 - (Date.now() % 1000));
  };
  tick();
}

// ===================== FETCH AVEC TIMEOUT + RETRY =====================
async function safeFetch(url, { method = "GET", headers, body, retries = CONFIG.fetchRetries, timeoutMs = CONFIG.fetchTimeoutMs } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
      return await res.json();  // await : une erreur de parsing JSON passe aussi par le retry
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt));  // backoff : 500 ms puis 1 s (retries = 2)
    }
  }
}

const haGet = (path) => safeFetch(path, { headers: AUTH_HEADERS });

// ===================== FORMATAGE =====================
function formatValue(stateObj, fallback = "N/A") {
  if (!stateObj) return fallback;
  if (stateObj.state === "unknown" || stateObj.state === "unavailable") return fallback;
  const raw = Number(stateObj.state);
  const unit = stateObj.attributes?.unit_of_measurement || "";
  if (Number.isFinite(raw)) return unit ? `${raw.toFixed(2)} ${unit}` : raw.toFixed(2);
  return unit ? `${stateObj.state} ${unit}` : stateObj.state;
}

function formatRainValue(stateObj) {
  if (!stateObj) return "N/A";
  if (stateObj.state === "unknown" || stateObj.state === "unavailable") return "N/A";
  const state = String(stateObj.state).toLowerCase();
  const deviceClass = stateObj.attributes?.device_class || "";
  if (deviceClass === "moisture" || ["on","wet","rain"].includes(state)) return "Oui";
  if (["off","dry","clear"].includes(state)) return "Non";
  return formatValue(stateObj);
}

// ===================== UI =====================
function updateUI(states) {

  const ent = CONFIG.homeAssistant.entities;
  const t = states.get(ent.temperature);

  if (t && t.state !== "unknown" && t.state !== "unavailable") {
    const value = Number(t.state);
    const unit = t.attributes?.unit_of_measurement || "°C";
    if (Number.isFinite(value)) {
      el.temp.textContent = `${value.toFixed(2)}${unit}`;
      el.emoji.textContent = getTemperatureEmoji(value);
    } else {
      el.temp.textContent = `--${unit}`;
      el.emoji.textContent = "❓";
    }
  } else {
    el.temp.textContent = "--°C";
    el.emoji.textContent = "❓";
  }

  el.hum.textContent   = formatValue(states.get(ent.humidity));
  el.pres.textContent  = formatValue(states.get(ent.pressure));
  el.wind.textContent  = formatValue(states.get(ent.wind));
  el.light.textContent = formatValue(states.get(ent.light));
  el.rain.textContent  = formatRainValue(states.get(ent.rain));
}

async function loadAllStates() {
  const list = await haGet("/api/states");
  // Map au lieu de {} : pas de clés héritées du prototype, lookup O(1) en moyenne
  const map = new Map();
  for (const s of list) map.set(s.entity_id, s);
  return map;
}

// ===================== CARTE LEAFLET =====================
function initMap(lat, lon) {
  mapInstance = L.map("map", { zoomControl: true }).setView([lat, lon], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
    referrerPolicy: "origin",
  }).addTo(mapInstance);
  marker = L.marker([lat, lon]).addTo(mapInstance);
}

function updateMap(lat, lon) {
  if (!mapInstance) return initMap(lat, lon);
  marker.setLatLng([lat, lon]);
  mapInstance.setView([lat, lon], mapInstance.getZoom());
}

function getHomeCoordinates(states) {
  const loc = states.get(CONFIG.homeAssistant.location);
  const lat = loc?.attributes?.latitude;
  const lon = loc?.attributes?.longitude;
  return (typeof lat === "number" && typeof lon === "number") ? { lat, lon } : null;
}

function updateLocation(states) {
  const coords = getHomeCoordinates(states);
  if (coords) updateMap(coords.lat, coords.lon);
}

// ===================== GRAPHIQUE Chart.js =====================
function initChart() {
  const ctx = document.getElementById("chart");
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: CHART_SERIES[currentChartKey].label,
        data: [],
        tension: 0.35,
        pointRadius: 2,
        pointHoverRadius: 5,
        borderWidth: 2.5,
        fill: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,           // ⚡ gain de perf énorme sur les updates fréquents
      plugins: { legend: { labels: { color: "#ffffff" } } },
      scales: {
        x: { ticks: { color:"#cbd5e1", maxTicksLimit: 8 }, grid: { color:"rgba(255,255,255,0.08)" } },
        y: { ticks: { color:"#cbd5e1" }, grid: { color:"rgba(255,255,255,0.08)" }, beginAtZero: false },
      },
    },
  });
}

function getCurrentTimeLabel() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;
}

function pushHistory(chartKey, value) {
  if (!Number.isFinite(value)) return;
  const store = historyStore[chartKey];
  store.labels.push(getCurrentTimeLabel());
  store.data.push(Number(value.toFixed(2)));
  if (store.labels.length > CONFIG.maxChartPoints) {
    store.labels.shift();
    store.data.shift();
  }
}

function renderCurrentChart() {

  if (!chart) initChart();
  const series = CHART_SERIES[currentChartKey];
  const store = historyStore[currentChartKey];
  chart.data.labels = store.labels;
  chart.data.datasets[0].data = store.data;
  chart.data.datasets[0].label = series.label;
  chart.update();
  el.chartTitle.textContent = series.title;
}

function setActiveButton(chartKey) {
  const buttons = {
    temperature: el.btnTemperature,
    humidity: el.btnHumidity,
    pressure: el.btnPressure,
    wind: el.btnWind,
  };
  for (const [key, btn] of Object.entries(buttons)) {
    if (!btn) continue;
    const isActive = key === chartKey;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive);
  }
}

function switchChart(chartKey) {
  currentChartKey = chartKey;
  setActiveButton(chartKey);
  renderCurrentChart();
  el.hint.textContent = `Graphique affiché : ${CHART_SERIES[chartKey].label}`;
}

function updateAllHistories(states) {
  const ent = CONFIG.homeAssistant.entities;
  const keys = ["temperature", "humidity", "pressure", "wind"];
  for (const key of keys) {
    const s = states.get(ent[key]);
    if (!s || s.state === "unknown" || s.state === "unavailable") continue;
    const v = Number(s.state);
    if (Number.isFinite(v)) pushHistory(key, v);
  }
  saveHistory();    // persistance dans sessionStorage
}

// ===================== GEOCODING + MÉTÉO EXTERNE =====================
async function geocodeCity(city) {
  const key = city.toLowerCase().trim();
  // Si déjà cherchée, on prend en cache au lieu de retaper l'API
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=fr&format=json`;
  const data = await safeFetch(url);
  if (!data.results?.length) throw new Error("Ville introuvable.");

  const place = data.results[0];

  const result = {
    lat: place.latitude,
    lon: place.longitude,
    name: place.name,
    country: place.country || "",
  };
  geocodeCache.set(key, result);   // on cache pour les prochains appels
  return result;
}

async function fetchMeteoFranceByCoords(lat, lon) {
  const url = `https://api.open-meteo.com/v1/meteofrance?latitude=${lat}&longitude=${lon}`
            + `&current=temperature_2m,relative_humidity_2m,apparent_temperature,surface_pressure,`
            + `wind_speed_10m,weather_code,precipitation,rain&timezone=auto`;
  return safeFetch(url);
}

function updateExternalWeatherUI(data, placeLabel = "--") {
  const c = data.current || {};
  el.extCity.textContent = placeLabel;
  el.extDesc.textContent = weatherDescriptionFr(c.weather_code);

  el.extTemp.textContent  = Number.isFinite(c.temperature_2m)       ? `${c.temperature_2m.toFixed(1)} °C` : "N/A";
  el.extFeels.textContent = Number.isFinite(c.apparent_temperature) ? `${c.apparent_temperature.toFixed(1)} °C` : "N/A";
  el.extHum.textContent   = Number.isFinite(c.relative_humidity_2m) ? `${c.relative_humidity_2m} %` : "N/A";
  el.extPres.textContent  = Number.isFinite(c.surface_pressure)     ? `${c.surface_pressure.toFixed(1)} hPa` : "N/A";
  el.extWind.textContent  = Number.isFinite(c.wind_speed_10m)       ? `${c.wind_speed_10m.toFixed(1)} km/h` : "N/A";

  if (Number.isFinite(c.rain) || Number.isFinite(c.precipitation)) {
    const r = Number.isFinite(c.rain) ? c.rain : c.precipitation;
    el.extRain.textContent = `${r.toFixed(1)} mm`;
  } else {
    el.extRain.textContent = "0.0 mm";
  }

  el.extIcon.textContent = getWeatherEmoji(c.weather_code);
}

async function refreshExternalWeatherFromHome(states) {
  const coords = getHomeCoordinates(states);
  if (!coords) {
    el.weatherStatus.textContent = "Impossible de lire la localisation Home Assistant.";
    return;
  }
  currentExternalCoords = coords;
  currentExternalPlaceName = "Localisation Home Assistant";
  el.weatherStatus.textContent = "Chargement de la météo locale…";
  const data = await fetchMeteoFranceByCoords(coords.lat, coords.lon);
  updateExternalWeatherUI(data, currentExternalPlaceName);

  el.weatherStatus.textContent = `Météo basée sur HA (${coords.lat.toFixed(4)}, ${coords.lon.toFixed(4)}).`;
}

async function refreshExternalWeatherFromCity(city) {
  el.weatherStatus.textContent = `Recherche de "${city}"…`;
  const place = await geocodeCity(city);
  currentExternalCoords = { lat: place.lat, lon: place.lon };
  currentExternalPlaceName = place.country ? `${place.name}, ${place.country}` : place.name;
  const data = await fetchMeteoFranceByCoords(place.lat, place.lon);
  updateExternalWeatherUI(data, currentExternalPlaceName);
  updateMap(place.lat, place.lon);
  el.weatherStatus.textContent = `Météo chargée pour ${currentExternalPlaceName}.`;
}

// ===================== DEBOUNCE =====================
function debounce(fn, wait = 250) {
  let id;
  return (...args) => { clearTimeout(id); id = setTimeout(() => fn(...args), wait); };
}

// ===================== BOUCLE PRINCIPALE =====================
async function refreshData() {
  try {
    const states = await loadAllStates();
    updateUI(states);
    updateLocation(states);
    updateAllHistories(states);
    renderCurrentChart();

    const key = CHART_SERIES[currentChartKey].entityKey;
    const currentState = states.get(CONFIG.homeAssistant.entities[key]);

    if (currentState && currentState.state !== "unknown" &&currentState.state !== "unavailable") {
      const v = Number(currentState.state);
      if (Number.isFinite(v)) {
        const unit = currentState.attributes?.unit_of_measurement || CHART_SERIES[currentChartKey].fallbackUnit;
        el.hint.textContent = `${CHART_SERIES[currentChartKey].label} : ${v.toFixed(2)} ${unit}`;
      } else {
        el.hint.textContent = `${CHART_SERIES[currentChartKey].label} non numérique.`;
      }
    } else {
      el.hint.textContent = `${CHART_SERIES[currentChartKey].label} indisponible.`;
    }

    if (!currentExternalCoords) await refreshExternalWeatherFromHome(states);
  } catch (e) {
    console.error(e);
    el.hint.textContent = `Erreur Home Assistant : ${e.message}`;
  }

}

async function periodicRefreshExternalWeather() {
  if (!currentExternalCoords) return;
  try {
    const data = await fetchMeteoFranceByCoords(currentExternalCoords.lat, currentExternalCoords.lon);
    updateExternalWeatherUI(data, currentExternalPlaceName || "Météo externe");
  } catch (e) {
    console.error(e);
    el.weatherStatus.textContent = `Erreur météo : ${e.message}`;
  }
}

// ===================== ÉVÉNEMENTS =====================
function setupButtons() {
  el.btnTemperature.onclick = () => switchChart("temperature");
  el.btnHumidity.onclick    = () => switchChart("humidity");
  el.btnPressure.onclick    = () => switchChart("pressure");
  el.btnWind.onclick        = () => switchChart("wind");
  setActiveButton(currentChartKey);

  // Recherche débounced : si l'user tape vite, on attend qu'il se calme
  const doCitySearch = debounce(async () => {
    const city = el.cityInput.value.trim();
    if (!city) { el.weatherStatus.textContent = "Entre une ville d'abord."; return; }
    try { await refreshExternalWeatherFromCity(city); }
    catch (e) { console.error(e); el.weatherStatus.textContent = e.message; }
  }, 200);

  el.btnSearchCity.onclick = doCitySearch;
  el.cityInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") doCitySearch();
  });

  el.btnUseHomeLocation.onclick = async () => {
    try {
      const states = await loadAllStates();
      await refreshExternalWeatherFromHome(states);
    } catch (e) { console.error(e); el.weatherStatus.textContent = e.message; }
  };
}

// ===================== NETTOYAGE =====================
// Quand l'user quitte la page, on ferme tout proprement
window.addEventListener("beforeunload", () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (weatherTimer) clearInterval(weatherTimer);
  saveHistory();
});

// ===================== DÉMARRAGE =====================
(function main() {
  if (!TOKEN) {

    el.hint.textContent = "Token manquant. Rafraîchis la page pour le saisir.";
    return;
  }

  startClock();
  setupButtons();
  initChart();
  renderCurrentChart();
  refreshData();

  refreshTimer = setInterval(refreshData, CONFIG.refreshMs);
  weatherTimer = setInterval(periodicRefreshExternalWeather, CONFIG.weatherRefreshMs);
})();
