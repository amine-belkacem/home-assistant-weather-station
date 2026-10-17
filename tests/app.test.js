// Tests auto-vérifiants du dashboard (node:test, aucune dépendance à installer).
// src/app.js est chargé tel quel dans un contexte isolé (vm) avec un faux DOM,
// un faux sessionStorage et un fetch contrôlé : le code testé n'est pas modifié.
//
// Lancer : node --test tests/

const test = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const APP = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");

// Comparaison avec message ECHEC : valeur obtenue / valeur attendue
function check(got, expected, label) {
  const ok = typeof expected === "object" && expected !== null
    ? JSON.stringify(got) === JSON.stringify(expected)
    : Object.is(got, expected);
  if (!ok) {
    throw new Error(`ECHEC ${label} : obtenu ${JSON.stringify(got)}, attendu ${JSON.stringify(expected)}`);
  }
}

// Élément DOM minimal : juste ce que app.js utilise
function fakeElement() {
  return {
    textContent: "", value: "", onclick: null,
    classList: { toggle() {} },
    setAttribute() {}, addEventListener() {},
  };
}

// Charge app.js dans un contexte neuf. Pas de token -> main() s'arrête tout de suite
// ("Token manquant"), donc aucun timer ni requête ne démarre pendant les tests.
function loadApp({ fetchImpl } = {}) {
  const elements = new Map();
  const storage = new Map();
  const ctx = {
    console,
    setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    AbortController,
    fetch: fetchImpl || (() => Promise.reject(new Error("fetch non prévu"))),
    prompt: () => "",
    sessionStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
    },
    window: { addEventListener() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(APP, ctx, { filename: "app.js" });
  return {
    ctx,
    el: (id) => elements.get(id),
    run: (code) => vm.runInContext(code, ctx),
  };
}

// États au format de GET /api/states (valeurs relevées pendant le TP)
const STATES = [
  { entity_id: "sensor.espbonbon_temperature_2", state: "24.67", attributes: { unit_of_measurement: "°C" } },
  { entity_id: "sensor.espbonbon_humidite_2", state: "21.78", attributes: { unit_of_measurement: "%" } },
  { entity_id: "sensor.espbonbon_pression_2", state: "995.8", attributes: { unit_of_measurement: "hPa" } },
  { entity_id: "sensor.esp32_weather_vent", state: "0.96", attributes: { unit_of_measurement: "km/h" } },
  { entity_id: "sensor.espbonbon_luminosite_2", state: "439.74", attributes: { unit_of_measurement: "lx" } },
  { entity_id: "sensor.espbonbon_pluviometrie", state: "0", attributes: { unit_of_measurement: "mm" } },
  { entity_id: "zone.home", state: "0", attributes: { latitude: 49.1197, longitude: 6.1764 } },
];

test("main() s'arrête proprement sans token", () => {
  const app = loadApp();
  check(app.el("hint").textContent, "Token manquant. Rafraîchis la page pour le saisir.", "message sans token");
});

test("formatValue : nombres arrondis à 2 décimales + unité", () => {
  const { ctx } = loadApp();
  const s = (state, unit) => ({ state, attributes: unit ? { unit_of_measurement: unit } : {} });
  check(ctx.formatValue(s("21.78", "%")), "21.78 %", "humidité");
  check(ctx.formatValue(s("995.8", "hPa")), "995.80 hPa", "pression (995.8 -> 995.80)");
  check(ctx.formatValue(s("5")), "5.00", "nombre sans unité");
  check(ctx.formatValue(s("abc", "lx")), "abc lx", "texte non numérique gardé tel quel");
  check(ctx.formatValue(s("unknown", "%")), "N/A", "état unknown");
  check(ctx.formatValue(s("unavailable", "%")), "N/A", "état unavailable");
  check(ctx.formatValue(undefined), "N/A", "entité absente");
});

test("formatRainValue : capteur binaire ou pluviomètre en mm", () => {
  const { ctx } = loadApp();
  check(ctx.formatRainValue({ state: "on", attributes: {} }), "Oui", "on");
  check(ctx.formatRainValue({ state: "WET", attributes: {} }), "Oui", "WET (majuscules)");
  check(ctx.formatRainValue({ state: "dry", attributes: {} }), "Non", "dry");
  check(ctx.formatRainValue({ state: "off", attributes: { device_class: "moisture" } }), "Non", "moisture à off = sec");
  check(ctx.formatRainValue({ state: "on", attributes: { device_class: "moisture" } }), "Oui", "moisture à on");
  check(ctx.formatRainValue({ state: "0", attributes: { unit_of_measurement: "mm" } }), "0.00 mm", "pluviomètre 0 mm");
  check(ctx.formatRainValue(null), "N/A", "entité absente");
});

test("getTemperatureEmoji : seuils 30 / 18 / 14 / 4 °C", () => {
  const { ctx } = loadApp();
  const cases = [[35, "🥵"], [30, "🥵"], [29.99, "😎"], [24.67, "😎"], [18, "😎"], [17.99, "🙂"],
                 [14, "🙂"], [13.99, "🥶"], [4, "🥶"], [3.99, "❄️"], [-5, "❄️"]];
  for (const [t, e] of cases) check(ctx.getTemperatureEmoji(t), e, `emoji pour ${t} °C`);
});

test("codes météo Open-Meteo : emoji et description", () => {
  const { ctx } = loadApp();
  check(ctx.getWeatherEmoji(0), "☀️", "code 0");
  check(ctx.weatherDescriptionFr(0), "Ciel dégagé", "description code 0");
  check(ctx.getWeatherEmoji(61), "🌧️", "code 61");
  check(ctx.weatherDescriptionFr(61), "Pluie faible", "description code 61");
  check(ctx.getWeatherEmoji(95), "⛈️", "code 95");
  check(ctx.weatherDescriptionFr(999), "Conditions météo inconnues", "code inconnu");
});

test("pushHistory : 40 points maximum, les plus anciens sortent", () => {
  const app = loadApp();
  for (let i = 1; i <= 45; i++) app.ctx.pushHistory("temperature", i);
  const data = app.run("historyStore.temperature.data");
  check(data.length, 40, "nombre de points gardés");
  // 45 valeurs poussées, 40 gardées -> les 5 premières (1 à 5) sont sorties
  check(data[0], 6, "plus ancien point gardé");
  check(data[39], 45, "dernier point");
  app.ctx.pushHistory("temperature", NaN);
  check(app.run("historyStore.temperature.data.length"), 40, "NaN ignoré");
  app.ctx.pushHistory("humidity", 21.456);
  check(app.run("historyStore.humidity.data[0]"), 21.46, "arrondi à 2 décimales");
});

test("updateUI : valeurs du TP affichées dans les cartes", () => {
  const app = loadApp();
  app.ctx.updateUI(new Map(STATES.map((s) => [s.entity_id, s])));
  check(app.el("tempValue").textContent, "24.67°C", "température");
  check(app.el("emoji").textContent, "😎", "emoji température");
  check(app.el("humValue").textContent, "21.78 %", "humidité");
  check(app.el("presValue").textContent, "995.80 hPa", "pression");
  check(app.el("windValue").textContent, "0.96 km/h", "vent");
  check(app.el("lightValue").textContent, "439.74 lx", "luminosité");
  check(app.el("rainValue").textContent, "0.00 mm", "pluie");
});

test("updateUI : capteur indisponible", () => {
  const app = loadApp();
  const states = new Map([["sensor.espbonbon_temperature_2", { state: "unavailable", attributes: {} }]]);
  app.ctx.updateUI(states);
  check(app.el("tempValue").textContent, "--°C", "température indisponible");
  check(app.el("emoji").textContent, "❓", "emoji indisponible");
  check(app.el("humValue").textContent, "N/A", "humidité absente");
});

// Faux fetch : rejoue une liste de réponses et compte les appels
function scriptedFetch(responses) {
  const calls = [];
  const fn = (url) => {
    calls.push(url);
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r === "network") return Promise.reject(new TypeError("Failed to fetch"));
    if (r === "badjson") return Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError("JSON invalide")) });
    if (typeof r === "number") return Promise.resolve({ ok: false, status: r, json: async () => ({}) });
    return Promise.resolve({ ok: true, status: 200, json: async () => r });
  };
  fn.calls = calls;
  return fn;
}

test("safeFetch : 2 erreurs réseau puis succès -> 3 appels, délais 500 ms puis 1 s", async () => {
  const fetchImpl = scriptedFetch(["network", "network", { ok: 1 }]);
  const { ctx } = loadApp({ fetchImpl });
  const t0 = Date.now();
  const data = await ctx.safeFetch("/api/states");
  const elapsed = Date.now() - t0;
  check(data, { ok: 1 }, "données renvoyées");
  check(fetchImpl.calls.length, 3, "nombre de tentatives");
  // attentes : 500 * 2^0 + 500 * 2^1 = 500 + 1000 = 1500 ms
  if (elapsed < 1450) throw new Error(`ECHEC backoff : obtenu ${elapsed} ms, attendu >= 1500 ms`);
});

test("safeFetch : abandon après 3 tentatives (retries = 2)", async () => {
  const fetchImpl = scriptedFetch([503]);
  const { ctx } = loadApp({ fetchImpl });
  let err = null;
  try { await ctx.safeFetch("/api/states"); } catch (e) { err = e; }
  check(err && err.message, "HTTP 503 sur /api/states", "erreur finale");
  check(fetchImpl.calls.length, 3, "nombre de tentatives");
});

test("safeFetch : un JSON invalide est aussi retenté (return await)", async () => {
  const fetchImpl = scriptedFetch(["badjson", { ok: 2 }]);
  const { ctx } = loadApp({ fetchImpl });
  const data = await ctx.safeFetch("/x", { retries: 1 });
  check(data, { ok: 2 }, "données après retry");
  check(fetchImpl.calls.length, 2, "nombre de tentatives");
});

test("safeFetch : timeout -> requête annulée par AbortController", async () => {
  // fetch qui ne répond jamais, sauf si le signal d'annulation se déclenche
  const fetchImpl = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const { ctx } = loadApp({ fetchImpl });
  const t0 = Date.now();
  let err = null;
  try { await ctx.safeFetch("/lent", { retries: 0, timeoutMs: 100 }); } catch (e) { err = e; }
  check(err && err.message, "aborted", "requête annulée");
  const elapsed = Date.now() - t0;
  if (elapsed > 1000) throw new Error(`ECHEC timeout : obtenu ${elapsed} ms, attendu ~100 ms`);
});

test("intégration avec le faux Home Assistant (tools/mock-ha-server.js)", async () => {
  const { server, TOKEN } = require("../tools/mock-ha-server.js");
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    check((await fetch(`${base}/api/states`)).status, 401, "sans token -> 401");

    // app.js appelle /api/states en relatif : on préfixe l'adresse du serveur et on ajoute le token
    const fetchImpl = (url, opts) => fetch(base + url, { ...opts, headers: { Authorization: `Bearer ${TOKEN}` } });
    const app = loadApp({ fetchImpl });
    const states = await app.ctx.loadAllStates();
    check(states.size, 7, "nombre d'entités");
    check(app.ctx.getHomeCoordinates(states), { lat: 49.1197, lon: 6.1764 }, "coordonnées zone.home");
    app.ctx.updateUI(states);
    check(app.el("humValue").textContent, "21.78 %", "humidité via le serveur");
    check(app.el("presValue").textContent, "995.80 hPa", "pression via le serveur");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
