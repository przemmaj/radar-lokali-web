// Zapis feedbacku od Pauliny do Vercel Blob.
//
// Dwa rodzaje wpisow:
//   oceny/<id oferty>.json  - kciuk i notatka przy konkretnej ofercie
//   uwagi/<timestamp>.json  - uwaga ogolna z formularza nad lista ofert
//
// Jeden plik na wpis, a nie jeden wspolny: dzieki temu dwa rownoczesne zapisy
// nie moga sie nadpisac. Ocena tej samej oferty nadpisuje swoj wlasny plik,
// wiec ostatnie klikniecie wygrywa - i o to chodzi.
//
// Zapis wymaga sekretu. Strona jest publiczna i adres da sie zgadnac, a oceny
// karmia strojenie wag scoringu - bez bramki kazdy moglby je zatruc.
import { put, list, get, del } from '@vercel/blob';

const LIMIT_NOTATKI = 500;
const LIMIT_UWAGI = 4000;

function odpowiedz(status, dane) {
  return new Response(JSON.stringify(dane), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// GET z sekretem oddaje WSZYSTKO razem z notatkami - strona potrzebuje tego,
// zeby po odswiezeniu pokazac to, co Paulina juz wpisala. Publiczny /api/oceny
// notatek nie zwraca.
async function wczytajWszystko() {
  const oceny = {};
  const uwagi = [];
  for (const prefix of ['oceny/', 'uwagi/']) {
    let cursor;
    do {
      const strona = await list({ prefix, cursor, limit: 250 });
      for (const b of strona.blobs) {
        const r = await get(b.url, { access: 'private', useCache: false });
        if (!r) continue;
        try {
          const d = JSON.parse(await new Response(r.stream).text());
          if (prefix === 'oceny/' && d && d.id) oceny[d.id] = d;
          if (prefix === 'uwagi/' && d && d.tresc) uwagi.push(d);
        } catch { /* pojedynczy uszkodzony wpis nie wywala calosci */ }
      }
      cursor = strona.cursor;
    } while (cursor);
  }
  uwagi.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return { oceny, uwagi };
}

// Kasowanie po sciezce: `del` chce URL-a blobu, a my znamy tylko sciezke,
// wiec najpierw listujemy. Uzywane przy wycofaniu kciuka i przy sprzataniu
// wpisow testowych.
async function usunPoPrefiksie(prefix, pasuje) {
  let cursor, ile = 0;
  do {
    const strona = await list({ prefix, cursor, limit: 250 });
    const doKasacji = strona.blobs.filter(pasuje).map((b) => b.url);
    if (doKasacji.length) {
      await del(doKasacji);
      ile += doKasacji.length;
    }
    cursor = strona.cursor;
  } while (cursor);
  return ile;
}

// UWAGA na sygnature. `export default async function handler(request)` Vercel
// czyta jako STARA sygnature Node'a (req, res): zwrocony Response jest wtedy
// ignorowany, res nigdy sie nie konczy i zadanie wisi do timeoutu - przy
// wdrozeniu w stanie READY i dzialajacej stronie. Web Handler to
// `export default { fetch(request) }` albo nazwane eksporty GET/POST.
export default {
 async fetch(request) {
  const sekretEnv = process.env.RADAR_SEKRET;

  if (request.method === 'GET') {
    const podany = new URL(request.url).searchParams.get('sekret');
    if (!sekretEnv || podany !== sekretEnv) {
      return odpowiedz(401, { blad: 'Brak uprawnien do odczytu' });
    }
    try {
      return odpowiedz(200, await wczytajWszystko());
    } catch (e) {
      return odpowiedz(500, { blad: String(e && e.message || e) });
    }
  }

  if (request.method === 'DELETE') {
    const q = new URL(request.url).searchParams;
    if (!sekretEnv || q.get('sekret') !== sekretEnv) {
      return odpowiedz(401, { blad: 'Brak uprawnien do kasowania' });
    }
    const uwaga = q.get('uwaga');
    const ocena = q.get('ocena');
    try {
      if (uwaga) {
        const ile = await usunPoPrefiksie('uwagi/', (b) => b.pathname.includes(uwaga));
        return odpowiedz(200, { ok: true, usunieto: ile });
      }
      if (ocena) {
        const ile = await usunPoPrefiksie('oceny/', (b) => b.pathname === `oceny/${ocena}.json`);
        return odpowiedz(200, { ok: true, usunieto: ile });
      }
      return odpowiedz(400, { blad: 'Podaj ?uwaga= albo ?ocena=' });
    } catch (e) {
      return odpowiedz(500, { blad: String(e && e.message || e) });
    }
  }

  if (request.method !== 'POST') {
    return odpowiedz(405, { blad: 'Tylko GET, POST albo DELETE' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return odpowiedz(400, { blad: 'Nieprawidlowy JSON' });
  }

  if (!sekretEnv || body.sekret !== sekretEnv) {
    // Swiadomie bez szczegolow - nie podpowiadamy, czy sekret w ogole istnieje.
    return odpowiedz(401, { blad: 'Brak uprawnien do zapisu' });
  }

  const teraz = new Date().toISOString();
  const kto = String(body.kto || 'paulina').slice(0, 40);

  try {
    if (body.typ === 'ogolne') {
      const tresc = String(body.tresc || '').trim().slice(0, LIMIT_UWAGI);
      if (!tresc) return odpowiedz(400, { blad: 'Pusta uwaga' });
      const sciezka = `uwagi/${teraz.replace(/[:.]/g, '-')}.json`;
      await put(sciezka, JSON.stringify({ tresc, kto, ts: teraz }), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
      });
      return odpowiedz(200, { ok: true, zapisano: 'uwaga' });
    }

    const id = String(body.id || '').trim();
    // Dwukropek MUSI przejsc: dzialki maja id typu "otodom:67900080". Waski
    // wzorzec odrzucal je z 400, a strona pokazywala tylko "nie udalo sie
    // zapisac" - wyglada identycznie jak awaria sieci. Kropka przechodzi,
    // ale ".." nie, zeby id nie skladalo sciezki.
    if (!id || !/^[A-Za-z0-9_:.-]{1,64}$/.test(id) || id.includes('..')) {
      return odpowiedz(400, { blad: 'Brak albo nieprawidlowe id oferty' });
    }
    const ocena = body.ocena === 'up' || body.ocena === 'down' ? body.ocena : '';
    const notatka = String(body.notatka || '').trim().slice(0, LIMIT_NOTATKI);

    if (!ocena && !notatka) {
      // Wycofanie kciuka razem z pusta notatka to nie jest ocena "zadna" -
      // to brak oceny. Pusty wpis wygladalby w eksporcie jak decyzja.
      await usunPoPrefiksie('oceny/', (b) => b.pathname === `oceny/${id}.json`);
      return odpowiedz(200, { ok: true, zapisano: 'wycofano' });
    }

    await put(`oceny/${id}.json`, JSON.stringify({ id, ocena, notatka, kto, ts: teraz }), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return odpowiedz(200, { ok: true, zapisano: 'ocena' });
  } catch (e) {
    return odpowiedz(500, { blad: 'Zapis sie nie udal', szczegol: String(e && e.message || e) });
  }
 }
};
