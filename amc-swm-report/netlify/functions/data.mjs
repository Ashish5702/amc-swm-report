// AMC North Zone SWM — data API (Netlify Function + Netlify Blobs)
// GET  /api/data?action=summary                 → saved dates summary (public)
// GET  /api/data?action=trips&from=..&to=..     → trips in date range (public)
// POST /api/data?action=login                   → check upload password
// POST /api/data?action=save                    → save trips (password)
// DELETE /api/data?action=date&date=YYYY-MM-DD  → delete one date (password)
// DELETE /api/data?action=all                   → delete everything (password)
import { getStore } from "@netlify/blobs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" }
});

// trip = [date, shift, ward, vehicle, netKg, time, uniqueKey]
const validTrip = t => Array.isArray(t) && t.length === 7 && DATE_RE.test(t[0]) && (t[1] === "Day" || t[1] === "Night")
  && typeof t[2] === "string" && typeof t[3] === "string" && Number.isFinite(t[4]) && t[4] >= 0 && t[4] < 20000
  && typeof t[5] === "string" && typeof t[6] === "string";

function summarize(day) {
  let N = 0, D = 0, net = 0;
  const wards = new Set(), veh = new Set();
  for (const t of day.trips) {
    if (t[1] === "Night") N++; else D++;
    net += t[4]; wards.add(t[2]); veh.add(t[2] + "|" + t[3]);
  }
  return { N, D, net, wards: [...wards].sort(), vehicles: veh.size, files: day.files.length };
}

export default async (req) => {
  const store = getStore({ name: "swm-trips", consistency: "strong" });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";
  const getSummary = async () => (await store.get("summary", { type: "json" })) || {};

  try {
    /* ---------- public (dashboard) ---------- */
    if (req.method === "GET") {
      if (action === "summary") return json(await getSummary());
      if (action === "trips") {
        const from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || "";
        if (!DATE_RE.test(from) || !DATE_RE.test(to)) return json({ error: "Invalid date range" }, 400);
        const dates = Object.keys(await getSummary()).filter(d => d >= from && d <= to).sort();
        if (dates.length > 400) return json({ error: "Date range too large (max about 13 months)" }, 400);
        const days = await Promise.all(dates.map(d => store.get(`day/${d}`, { type: "json" })));
        return json({ trips: days.flatMap(x => (x && x.trips) || []) });
      }
      return json({ error: "Unknown action" }, 400);
    }

    /* ---------- operator only ---------- */
    const password = Netlify.env.get("UPLOAD_PASSWORD");
    if (!password) return json({ error: "UPLOAD_PASSWORD is not set in Netlify environment variables" }, 500);
    if (req.headers.get("x-upload-key") !== password) return json({ error: "Wrong password" }, 401);

    if (req.method === "POST" && action === "login") return json({ ok: true });

    if (req.method === "POST" && action === "save") {
      const body = await req.json();
      const trips = Array.isArray(body.trips) ? body.trips : [];
      const files = Array.isArray(body.files) ? body.files : [];
      if (!trips.length || trips.length > 50000 || !trips.every(validTrip)) return json({ error: "Invalid trip data" }, 400);

      const byDate = new Map();
      for (const t of trips) { if (!byDate.has(t[0])) byDate.set(t[0], []); byDate.get(t[0]).push(t); }

      const summary = await getSummary();
      const at = new Date().toISOString();
      let added = 0, updated = 0;
      for (const [d, list] of byDate) {
        const day = (await store.get(`day/${d}`, { type: "json" })) || { trips: [], files: [] };
        const idx = new Map(day.trips.map((t, i) => [t[6], i]));
        for (const t of list) {
          if (idx.has(t[6])) { day.trips[idx.get(t[6])] = t; updated++; }        // re-upload → update, never duplicate
          else { idx.set(t[6], day.trips.length); day.trips.push(t); added++; }
        }
        for (const f of files) if ((f.dates || []).includes(d)) day.files.push({ f: String(f.f || ""), shift: f.shift, n: f.n, at });
        await store.setJSON(`day/${d}`, day);
        summary[d] = summarize(day);
      }
      await store.setJSON("summary", summary);
      return json({ added, updated, dates: [...byDate.keys()].sort() });
    }

    if (req.method === "DELETE" && action === "date") {
      const d = url.searchParams.get("date") || "";
      if (!DATE_RE.test(d)) return json({ error: "Invalid date" }, 400);
      await store.delete(`day/${d}`);
      const summary = await getSummary(); delete summary[d];
      await store.setJSON("summary", summary);
      return json({ ok: true });
    }

    if (req.method === "DELETE" && action === "all") {
      const summary = await getSummary();
      await Promise.all(Object.keys(summary).map(d => store.delete(`day/${d}`)));
      await store.setJSON("summary", {});
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};

export const config = { path: "/api/data" };