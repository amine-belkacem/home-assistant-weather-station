// Faux Home Assistant pour lancer le dashboard sans la station du TP.
// Sert les fichiers de src/ et répond à GET /api/states avec les valeurs
// relevées sur le dashboard pendant le TP (capture docs/dashboard.jpeg).
//
// Usage : node tools/mock-ha-server.js   puis ouvrir http://localhost:8123
// Token à coller dans la page : demo-token

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8123;
const TOKEN = "demo-token";
const SRC = path.join(__dirname, "..", "src");

const STATES = [
  { entity_id: "sensor.espbonbon_temperature_2", state: "24.67", attributes: { unit_of_measurement: "°C" } },
  { entity_id: "sensor.espbonbon_humidite_2", state: "21.78", attributes: { unit_of_measurement: "%" } },
  { entity_id: "sensor.espbonbon_pression_2", state: "995.80", attributes: { unit_of_measurement: "hPa" } },
  { entity_id: "sensor.esp32_weather_vent", state: "0.96", attributes: { unit_of_measurement: "km/h" } },
  { entity_id: "sensor.espbonbon_luminosite_2", state: "439.74", attributes: { unit_of_measurement: "lx" } },
  { entity_id: "sensor.espbonbon_pluviometrie", state: "0.00", attributes: { unit_of_measurement: "mm" } },
  // Coordonnées de la zone "home" du Home Assistant du TP (Metz)
  { entity_id: "zone.home", state: "0", attributes: { latitude: 49.1197, longitude: 6.1764 } },
];

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

// Petite variation sur la température pour que le graphique bouge pendant la démo
function currentStates() {
  const t = 24.67 + Math.sin(Date.now() / 20000) * 0.3;
  return STATES.map((s) =>
    s.entity_id === "sensor.espbonbon_temperature_2" ? { ...s, state: t.toFixed(2) } : s
  );
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/states") {
    // Même contrôle que Home Assistant : sans le bon token, 401
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "401: Unauthorized" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(currentStates()));
  }

  // Fichiers statiques de src/ (on refuse de sortir du dossier)
  const file = path.normalize(path.join(SRC, url === "/" ? "index.html" : url));
  if (!file.startsWith(SRC)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": `${MIME[path.extname(file)] || "application/octet-stream"}; charset=utf-8` });
    res.end(data);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Faux Home Assistant sur http://localhost:${PORT} (token : ${TOKEN})`);
  });
}

module.exports = { server, STATES, TOKEN };
