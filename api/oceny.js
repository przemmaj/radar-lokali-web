// Oceny do strojenia wag scoringu - endpoint PUBLICZNY, ale celowo ubogi.
//
// Zwraca wylacznie id oferty i kciuk. NIE zwraca notatek ani uwag ogolnych:
// to jedyne miejsce, gdzie Paulina pisze wlasnymi slowami, i nie ma powodu
// wystawiac tego na publiczny adres. Notatki trafiaja do cotygodniowego maila
// do Przemka.
//
// Dzieki temu, ze odczyt jest otwarty, cotygodniowy przebieg w chmurze nie
// potrzebuje ZADNEGO sekretu, zeby zasilic tune_wagi.py.
import { list, get } from '@vercel/blob';

// Web Handler, nie stara sygnatura Node'a - patrz komentarz w feedback.js.
export default {
 async fetch() {
  try {
    const oceny = [];
    let cursor;
    do {
      const strona = await list({ prefix: 'oceny/', cursor, limit: 250 });
      for (const b of strona.blobs) {
        // useCache:false obowiazkowo. Domyslnie get() cache'uje, wiec po
        // zmianie kciuka odczyt oddawal STARA wartosc - sprawdzone.
        const r = await get(b.url, { access: 'private', useCache: false });
        if (!r) continue;
        try {
          const d = JSON.parse(await new Response(r.stream).text());
          if (d && d.id && d.ocena) oceny.push({ id: d.id, ocena: d.ocena, ts: d.ts });
        } catch { /* pojedynczy uszkodzony wpis nie moze wywalic calosci */ }
      }
      cursor = strona.cursor;
    } while (cursor);

    return new Response(JSON.stringify({ oceny, ile: oceny.length }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // no-store, nie max-age. Z tego endpointu czyta cotygodniowy przebieg,
        // wiec zysk z cache jest zaden, a ryzyko realne: zbuforowana pusta
        // odpowiedz wygladalaby jak "brak ocen" i po cichu zatrzymala
        // strojenie wag. Sprawdzone - przy max-age=60 wlasnie tak bylo.
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ blad: String(e && e.message || e) }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
 }
};
