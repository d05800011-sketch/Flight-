// Загружает расписание вылетов и прилётов из AirLabs и сохраняет в data/flights.json.
// Запускается GitHub Actions; ключ берётся из секрета AIRLABS_API_KEY.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://airlabs.co/api/v9/schedules';
const OUT = 'data/flights.json';

// Смещение местного времени аэропорта от UTC (на случай, если в ответе нет *_ts)
const UTC_OFFSET = { SVO: 3, DME: 3, VKO: 3, LED: 3, KZN: 3, AER: 3, KGD: 2, SVX: 5 };

// IATA-код аэропорта -> название города для табло (до 13 символов)
const CITY = {
  SVO: 'МОСКВА', DME: 'МОСКВА', VKO: 'МОСКВА', ZIA: 'МОСКВА', LED: 'ПЕТЕРБУРГ', AER: 'СОЧИ', KZN: 'КАЗАНЬ',
  KGD: 'КАЛИНИНГРАД', SVX: 'ЕКАТЕРИНБУРГ', OVB: 'НОВОСИБИРСК', KJA: 'КРАСНОЯРСК', IKT: 'ИРКУТСК',
  VVO: 'ВЛАДИВОСТОК', KHV: 'ХАБАРОВСК', UFA: 'УФА', KUF: 'САМАРА', KRR: 'КРАСНОДАР', MRV: 'МИН. ВОДЫ',
  MMK: 'МУРМАНСК', ARH: 'АРХАНГЕЛЬСК', TJM: 'ТЮМЕНЬ', ROV: 'РОСТОВ', VOZ: 'ВОРОНЕЖ', GOJ: 'Н. НОВГОРОД',
  PEE: 'ПЕРМЬ', CEK: 'ЧЕЛЯБИНСК', OMS: 'ОМСК', YKS: 'ЯКУТСК', AAQ: 'АНАПА', KGP: 'КОГАЛЫМ',
  NJC: 'НИЖНЕВАРТОВСК', SGC: 'СУРГУТ', HMA: 'ХАНТЫ-МАНСИЙСК',
  IST: 'СТАМБУЛ', SAW: 'СТАМБУЛ', AYT: 'АНТАЛЬЯ', DXB: 'ДУБАЙ', MSQ: 'МИНСК', EVN: 'ЕРЕВАН', TBS: 'ТБИЛИСИ',
  GYD: 'БАКУ', ALA: 'АЛМАТЫ', NQZ: 'АСТАНА', TAS: 'ТАШКЕНТ', HRG: 'ХУРГАДА', DEL: 'ДЕЛИ', PEK: 'ПЕКИН',
};

// kind: 'dep' (вылеты) или 'arr' (прилёты)
function otherCity(r, kind) {
  const o = kind === 'arr' ? 'dep' : 'arr'; // для вылета показываем, куда летит; для прилёта, откуда
  const name = CITY[r[`${o}_iata`]] || (r[`${o}_city`] ? String(r[`${o}_city`]).toUpperCase() : r[`${o}_iata`]) || '';
  return name.slice(0, 13);
}

// Ответ AirLabs -> компактные строки для табло
export function convert(rows, code, kind = 'dep', nowSec = Math.floor(Date.now() / 1000)) {
  const P = kind === 'arr' ? 'arr' : 'dep';
  const off = UTC_OFFSET[code] ?? 3;
  const parseLocal = (s) => {
    if (!s) return null;
    const iso = String(s).replace(' ', 'T') + (String(s).length <= 16 ? ':00' : '') + 'Z';
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms / 1000 - off * 3600;
  };
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.cs_flight_iata) continue; // дубли код-шеринга: оставляем рейс оператора
    const sched = r[`${P}_time_ts`] ?? parseLocal(r[`${P}_time`]);
    if (!sched) continue;
    const est = r[`${P}_estimated_ts`] ?? parseLocal(r[`${P}_estimated`]) ?? sched;
    const delay = Math.max(Math.round((est - sched) / 60), Number(r[`${P}_delayed`]) || 0, 0);
    const ts = Math.max(est, sched + delay * 60);
    if (ts < nowSec - 3600) continue;
    const st = String(r.status || '').toLowerCase();
    let state = 'scheduled';
    if (st === 'cancelled') state = 'cancelled';
    else if (kind === 'arr' && st === 'landed') state = 'landed';
    else if (kind !== 'arr' && (st === 'active' || st === 'landed')) state = 'departed';
    const flight = String(r.flight_iata || '').replace(/^([A-Z0-9]{2})(\d)/, '$1 $2').slice(0, 7);
    const key = flight + '|' + sched;
    if (!flight || seen.has(key)) continue;
    seen.add(key);
    // для вылета это выход на посадку, для прилёта лента выдачи багажа
    const gateRaw = kind === 'arr' ? r.arr_baggage : r.dep_gate;
    const other = kind === 'arr' ? 'dep' : 'arr';
    out.push({
      ts, delay, flight,
      al: r.airline_iata || flight.split(' ')[0],
      dest: otherCity(r, kind),
      iata: r[`${other}_iata`] || '',
      gate: gateRaw ? String(gateRaw).slice(0, 4) : '',
      term: r[`${P}_terminal`] ? String(r[`${P}_terminal`]).slice(0, 3) : '',
      ac: r.aircraft_icao || '',
      dur: Number(r.duration) || 0,
      state,
    });
  }
  return out.sort((a, b) => a.ts - b.ts).slice(0, 60);
}

async function fetchAirport(code, key, pages, kind) {
  const filter = kind === 'arr' ? 'arr_iata' : 'dep_iata';
  const all = [];
  for (let p = 0; p < pages; p++) {
    const url = `${API}?${filter}=${code}&limit=50&offset=${p * 50}&api_key=${encodeURIComponent(key)}`;
    const res = await fetch(url);
    const j = await res.json();
    if (j.error) throw new Error(`${code} ${kind}: ${j.error.message || JSON.stringify(j.error)}`);
    all.push(...(j.response || []));
    if (!j.request || !j.request.has_more) break;
  }
  return all;
}

async function main() {
  const key = process.env.AIRLABS_API_KEY;
  if (!key) throw new Error('Не задан секрет AIRLABS_API_KEY');
  const airports = (process.env.AIRPORTS || 'SVO,LED,AER').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const boards = (process.env.BOARDS || 'dep,arr').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s === 'dep' || s === 'arr');
  const pages = Math.max(1, Number(process.env.MAX_PAGES) || 1);

  let data = {};
  try { data = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { /* первый запуск */ }
  data.airports = data.airports || {}; // вылеты
  data.arrivals = data.arrivals || {}; // прилёты

  let ok = 0;
  for (const kind of boards) {
    const target = kind === 'arr' ? data.arrivals : data.airports;
    for (const code of airports) {
      try {
        const rows = await fetchAirport(code, key, pages, kind);
        target[code] = convert(rows, code, kind);
        ok++;
        console.log(`${code} ${kind}: получено ${rows.length}, на табло ${target[code].length}`);
      } catch (e) {
        console.warn(`${code} ${kind}: ошибка, оставляю прошлые данные. ${e.message}`);
      }
    }
  }
  if (!ok) throw new Error('Ничего не обновилось');

  data.updated = new Date().toISOString();
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(data));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
