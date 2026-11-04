// Estrae le lezioni dalla pagina EasyStaff (Università di Padova) e genera:
//  - un file .ics per ogni insegnamento
//  - un file .ics completo con tutti gli insegnamenti
//
// Uso:  node build.ts [pagina.html | URL] <cartella_output>
// Richiede Node 22.18+ (supporto nativo a TypeScript) e Playwright per caricare la pagina
// in un browser vero, perché la tabella degli orari viene costruita via JavaScript.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

// ---------- tipi ----------

interface Lesson {
  courseCode: string;   // es. EC952727
  courseName: string;   // es. ANALISI MATEMATICA 1
  kind: string;         // es. Lezione, Esercitazione
  start: Date;          // istante UTC
  end: Date;
  room: string;         // es. H9
  teachers: string[];
}

// ---------- utilità di data (Europe/Rome) ----------

const MONTHS: Record<string, number> = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

// Offset in minuti di Europe/Rome rispetto a UTC in un dato istante.
function romeOffsetMinutes(ms: number): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - ms) / 60000);
}

// Converte un orario locale di Roma in istante UTC.
function romeToUtc(y: number, m: number, d: number, hh: number, mm: number): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let offset = romeOffsetMinutes(guess);
  let utc = guess - offset * 60000;
  // ricontrollo: l'offset può cambiare attorno al cambio d'ora
  const offset2 = romeOffsetMinutes(utc);
  if (offset2 !== offset) utc = guess - offset2 * 60000;
  return new Date(utc);
}

// ---------- parsing HTML ----------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTeachers(segment: string): string[] {
  const m = segment.match(/id="docenti"[\s\S]*?<\/div>/);
  if (!m) return [];
  const names: string[] = [];
  for (const t of m[0].matchAll(/aria-label="([^"]+)"/g)) names.push(decodeEntities(t[1]));
  return names;
}

function parseCourseName(segment: string): string | null {
  const m = segment.match(/id="nome_corso"[^>]*>(?:<a [^>]*>)?([^<]+)/);
  return m ? decodeEntities(m[1]) : null;
}

// Ogni riga di corso ha data-codice; dentro c'è il popup con l'elenco di tutte le date.
function parseRows(html: string): Lesson[] {
  const lessons: Lesson[] = [];
  const rowRe = /data-codice="([A-Z0-9]+)"/g;
  const starts: { code: string; index: number }[] = [];
  for (const m of html.matchAll(rowRe)) {
    if (m[1] === "checkall") continue; // è un controllo della legenda, non un corso
    starts.push({ code: m[1], index: m.index ?? 0 });
  }

  for (let i = 0; i < starts.length; i++) {
    const { code, index } = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].index : html.length;
    const segment = html.slice(index, end);

    const courseName = parseCourseName(segment);
    const datesBlock = segment.match(/id="date_eventi"[\s\S]*?(?=<div class="calendar-table-col")/);
    if (!courseName || !datesBlock) continue;

    const teachers = parseTeachers(segment);

    // Ogni voce inizia con il nome del giorno: divido la lista su quelle posizioni.
    const block = datesBlock[0];
    const startRe = /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+\d{2}:\d{2}/g;
    const dayStarts = [...block.matchAll(startRe)].map((m) => m.index ?? 0);
    const entries = dayStarts.map((s, k) =>
      block.slice(s, k + 1 < dayStarts.length ? dayStarts[k + 1] : block.length));

    for (const entry of entries) {
      const dm = entry.match(
        /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2}),\s*([^,<]*?),/
      );
      if (!dm) continue;
      const [, , day, monthName, year, sh, sm, eh, em, kindRaw] = dm;
      const month = MONTHS[monthName];
      if (!month) continue;

      // Lezioni annullate: le escludo dal calendario.
      if (/cancelled/i.test(entry)) continue;

      const roomM = entry.match(/title-descr-room-popup[^"]*">([^<]+)</);
      const room = roomM ? decodeEntities(roomM[1]) : "";

      lessons.push({
        courseCode: code,
        courseName,
        kind: decodeEntities(kindRaw) || "Lezione",
        start: romeToUtc(Number(year), month, Number(day), Number(sh), Number(sm)),
        end: romeToUtc(Number(year), month, Number(day), Number(eh), Number(em)),
        room,
        teachers,
      });
    }
  }

  // De-duplica: lo stesso evento compare in più righe della stessa materia.
  const seen = new Map<string, Lesson>();
  for (const l of lessons) {
    const key = `${l.courseCode}|${l.start.toISOString()}|${l.room}`;
    if (!seen.has(key)) seen.set(key, l);
  }
  return [...seen.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

// ---------- generazione ICS ----------

function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// RFC 5545: righe piegate a 75 caratteri.
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 0) {
    parts.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  return parts.join("\r\n");
}

function buildIcs(calName: string, lessons: Lesson[]): string {
  const now = icsDate(new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//calendario-unipd//orario//IT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(calName)}`,
    "X-WR-TIMEZONE:Europe/Rome",
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
    "X-PUBLISHED-TTL:PT12H",
  ];

  for (const l of lessons) {
    const summary = `${l.courseName} (${l.kind})`;
    const descParts = [];
    if (l.teachers.length) descParts.push(`Docenti: ${l.teachers.join(", ")}`);
    descParts.push(`Codice: ${l.courseCode}`);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${l.courseCode}-${icsDate(l.start)}-${l.room.replace(/\W/g, "")}@calendario-unipd`,
      `DTSTAMP:${now}`,
      `DTSTART:${icsDate(l.start)}`,
      `DTEND:${icsDate(l.end)}`,
      fold(`SUMMARY:${icsEscape(summary)}`),
      fold(`LOCATION:${icsEscape(l.room ? `Aula ${l.room} - HUB, via Tommaseo 59, Padova` : "")}`),
      fold(`DESCRIPTION:${icsEscape(descParts.join("\n"))}`),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function slugify(s: string): string {
  return s
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ---------- main ----------

// Codici degli insegnamenti attesi. Se uno sparisce dalla pagina, lo script si ferma
// e non tocca i file: meglio un avviso che un calendario incompleto.
const EXPECTED_CODES = ["EC952727", "EC952728", "EC952729", "EC151609", "EC151617"];

// Se il numero di eventi scende sotto questa frazione del valore precedente, si ferma.
const MIN_RATIO = 0.5;

const BASE_URL = "https://agendastudentiunipd.easystaff.it/index.php";

function timetableUrl(): string {
  const today = new Date().toISOString().slice(0, 10);
  // Stessi parametri di una richiesta fatta dal browser (il modulo viene inviato via JavaScript).
  const params = new URLSearchParams({
    view: "easycourse",
    "form-type": "corso",
    include: "corso",
    "txtcurr": "1 - ENERGETICO",
    anno: "2026",
    scuola: "ScuoladiIngegneria",
    corso: "IN2917",
    date: today,
    periodo_didattico: "",
    _lang: "en",
    list: "",
    week_grid_type: "-1",
    ar_codes_: "",
    ar_select_: "",
    col_cells: "0",
    empty_box: "0",
    only_grid: "0",
    highlighted_date: "0",
    all_events: "0",
    faculty_group: "0",
  });
  params.append("anno2[]", "001PD|1");
  return `${BASE_URL}?${params.toString()}`;
}

// Carica la pagina in un Chromium headless, così il JavaScript costruisce la tabella come nel browser.
async function loadSource(src: string): Promise<string> {
  if (!src.startsWith("http")) return readFileSync(src, "utf8");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ locale: "it-IT" });
    await page.goto(src, { waitUntil: "networkidle", timeout: 90_000 });
    // Aspetto che compaiano le righe dei corsi; se non compaiono, restituisco comunque la pagina
    // e sarà il controllo successivo a fermare lo script.
    await page.waitForSelector("[data-codice]", { timeout: 60_000 }).catch(() => {});
    return await page.content();
  } finally {
    await browser.close();
  }
}

function fail(msg: string): never {
  console.error(`ERRORE: ${msg}`);
  console.error("Nessun file è stato modificato.");
  process.exit(1);
}

async function main() {
  const source = process.argv[2] || timetableUrl();
  const outDir = process.argv[3] || "docs";
  mkdirSync(outDir, { recursive: true });

  let html: string;
  try {
    html = await loadSource(source);
  } catch (e) {
    fail(`impossibile leggere la pagina (${(e as Error).message})`);
  }

  if (!html.includes("data-codice")) {
    // Salvo la pagina ricevuta, così si può capire cosa ha restituito il sito.
    writeFileSync("pagina-debug.html", html);
    fail("la pagina non contiene più la tabella degli orari: il sito può essere cambiato");
  }

  const lessons = parseRows(html);
  const codes = new Set(lessons.map((l) => l.courseCode));
  const missing = EXPECTED_CODES.filter((c) => !codes.has(c));
  if (missing.length) {
    writeFileSync("pagina-debug.html", html);
    const found = [...codes].join(", ") || "nessuno";
    fail(`insegnamenti attesi non trovati: ${missing.join(", ")}. Codici trovati: ${found}. Lezioni estratte: ${lessons.length}`);
  }
  if (lessons.length === 0) fail("nessun evento estratto");

  // Confronto con l'ultima esecuzione: se gli eventi crollano, qualcosa è cambiato.
  const statePath = join(outDir, "state.json");
  if (existsSync(statePath)) {
    const prev = JSON.parse(readFileSync(statePath, "utf8")) as { total: number };
    if (lessons.length < prev.total * MIN_RATIO) {
      fail(`eventi passati da ${prev.total} a ${lessons.length}: possibile cambiamento del sito`);
    }
  }

  // Tutti i controlli superati: scrivo i file.
  const byCourse = new Map<string, Lesson[]>();
  for (const l of lessons) {
    const arr = byCourse.get(l.courseCode) ?? [];
    arr.push(l);
    byCourse.set(l.courseCode, arr);
  }

  writeFileSync(join(outDir, "calendario-completo.ics"), buildIcs("Ingegneria dell'Energia - tutto", lessons));
  for (const [code, items] of byCourse) {
    const name = items[0].courseName;
    writeFileSync(join(outDir, `${code}-${slugify(name)}.ics`), buildIcs(name, items));
    console.log(`${code}-${slugify(name)}.ics: ${items.length} eventi`);
  }
  writeFileSync(statePath, JSON.stringify({ total: lessons.length, updated: new Date().toISOString() }, null, 2));
  console.log(`calendario-completo.ics: ${lessons.length} eventi totali`);
}

main();
