# BRAMA VTT

**Vícejazyčný virtuální herní stůl od [CrioMant](https://github.com/CrioNIK).**

[English — originál](../../README.md) · [Українська](../uk/README.md) · [Español](../es/README.md) · [Polski](../pl/README.md) · [Čeština](README.md)

Vytvářím BRAMU jako společný prostor pro příběhy u herního stolu: mapu, postavy, kostky, deníky a jasné rozlišení mezi pohledem vypravěče a jednotlivých hráčů. Aplikace běží na vašem počítači a ukládá stav kampaně do místní databáze.

**Zdrojový kód je dostupný pro nekomerční použití. Komerční použití vyžaduje můj předchozí písemný souhlas.** Viz [licence](LICENSE.md). Kvůli tomuto omezení projekt není šířen pod licencí open source ve smyslu OSI. Závislosti třetích stran si ponechávají vlastní licence uvedené v [oznámeních o součástech třetích stran](THIRD_PARTY_NOTICES.md).

## Dostupné funkce

- Scény se čtvercovou mřížkou, úrovněmi, žetony, zdmi, dveřmi, světly, měřením a omezeným modelem viditelnosti.
- Oddělené relace vypravěče a hráčů, výslovná oprávnění a filtrování soukromých informací na serveru.
- Listy postav, inventář, ověření vlastností, záchranné hody, dovednosti, zdroje, účinky a nastavitelný rozvoj.
- Náklady akcí, výsledky hodů a výslovné uplatnění zranění či léčení jako samostatné kroky.
- Pořadí boje s iniciativou, řazením shodných výsledků, počítadly a obnovením předchozího tahu.
- Deníky s formátovaným textem, obrázky, složkami, právy dokumentů a stránek, soukromými poznámkami vypravěče a cílenými prezentacemi.
- Export kampaně do JSON, ověřovaný import výměnných dokumentů a trvalá potvrzení podporovaných příkazů.

Rozhraní podporuje **angličtinu, španělštinu, ukrajinštinu, polštinu a češtinu**. Výchozí jazyk je ukrajinština; přepínač si pamatuje vaši volbu. Změna jazyka rozhraní nepřekládá ani nenahrazuje obsah kampaně napsaný hráči. Původní dokumentace je anglická; ostatní čtyři vydání obsahují stejné informace.

## Místní spuštění

Nainstalujte **Node.js 24.12 nebo novější v řadě 24.x** a spusťte:

```sh
git clone https://github.com/CrioNIK/brama-vtt.git
cd brama-vtt
npm ci
npm run build
npm start
```

Otevřete **http://127.0.0.1:8015/**. Vytvořte kampaň a její pozvánku otevřete na jiné kartě, kde se připojíte jako hráč. Vypravěč uděluje přístup k žetonům a postavám zvlášť. Přihlašovací údaje relace zůstávají v dané kartě prohlížeče; kartu vypravěče ponechte dostupnou.

Server záměrně naslouchá pouze na místním rozhraní. Pozvánky fungují na tomto počítači; internetový hosting ani obnova účtů nejsou zahrnuty. `PORT` mění místní port a `VTT_DB` cestu k SQLite. Výchozí databáze je `server/data/vtt.sqlite`.

## Hraní a tvorba

Nástroje mapy slouží k výběru a pohybu objektů, měření vzdáleností a přidávání žetonů, zdí, dveří a světel. Před úpravami zvolte scénu a úroveň. Vlastnictví žetonu určuje, kdo jej může ovládat; práva listu určují, kdo smí prohlížet údaje postavy.

Akce postav a jejich náklady na zdroje vytvářejte výslovně. Před provedením akce zkontrolujte cenu. Úspěšná akce může vytvořit hod; uplatnění jeho zranění nebo léčení je další samostatnou operací. Zobrazený výsledek kostek proto automaticky nemění životy.

V boji přidejte účastníky, nastavte nebo hoďte iniciativu a začněte střetnutí. Pořadí podporuje poražené účastníky, shodnou iniciativu, počítadla a vrácení předchozího přechodu. Nevynucuje všechna pravidla ani nezakazuje pohyb po mapě mimo tah.

Deníky používejte pro podklady a poznámky. Stránky mohou dědit přístup dokumentu nebo mít vlastní oprávnění. Cílená prezentace odešle uloženou kopii vybraných stránek bez trvalého přístupu k originálu. Pozdější úpravy kopii nemění. Archivace deníku odvolá aktivní prezentace; obnovení je znovu neodešle.

Kampaň pravidelně exportujte. Export je přenositelný dokument JSON; nenahrazuje pracovní databázi ani neslibuje obnovu kampaně jediným kliknutím. Pro konzistentní místní zálohu zastavte server před kopírováním databáze a souvisejících souborů SQLite. Do veřejného repozitáře nepřidávejte databáze kampaní, exporty, kódy pozvánek ani přihlašovací údaje relací.

## Vývoj a ověření

```sh
npm test
npm run typecheck
npm run build
```

Pro samostatný vývoj klienta spusťte `npm run dev` a `npm run client` ve dvou terminálech. Vite používá port 5173 a přeposílá API a WebSocket na port 8015.

Projekt používá React, TypeScript, Vite, SQLite v Node, WebSocket, Tiptap a čištění HTML. `client/` obsahuje rozhraní, `server/` autoritativní příkazy a ukládání, `shared/` datové kontrakty a pomocná pravidla a `tests/` regresní testy se samostatnými testovacími daty. Překlady používají anglické klíče a pojmenované parametry; text hráčů není překladový klíč.

Změny musí zachovat ověřování příkazů, oprávnění, atomické zápisy a chování opakovaných pokusů. Ztráta potvrzení nedokazuje selhání příkazu. Dokud výsledek neznáte, použijte obnovu výsledku v rozhraní místo vytvoření nové operace. Viz [Přispívání](CONTRIBUTING.md) a [Bezpečnost](SECURITY.md).

## Současné hranice

Viditelnost žetonu se ověřuje v jeho středu a v bodech uvnitř vykresleného kruhového těla: částečně odkrytý žeton může být viditelný, i když je jeho střed za zdí. Hustota vzorkování závisí na velikosti žetonu a je omezena na 257 bodů; úzký otvor mezi nimi může být stále přehlédnut. Rohy rámečku výběru, popisky ani obrysy nezajišťují viditelnost. Skrytí žetonu a oprávnění vlastníků se kontrolují samostatně. Mlha zakrývá mapu vizuálně; geometrie scény a obrázky pozadí se stále odesílají hráčům a nejsou důvěrné.

BRAMA je raná funkční aplikace. Neobsahuje kompletní pravidla, neomezené skriptování, společné slučování textu, úplný cyklus importu a exportu externích deníků, značky mapy, stránky audio/video/PDF ani veřejný hosting. Nepodporovaná importovaná pravidla se hlásí nebo odmítají, nikoli tiše provádějí. Model viditelnosti a mobilní úpravy mají výslovná omezení. Úspěšné testy potvrzují ověřené kontrakty, ne univerzální kompatibilitu ani všechny možné herní situace.

## Autor a oprávnění

Autor a správce: **CrioMant / [CrioNIK](https://github.com/CrioNIK)**. O komerční souhlas požádejte prostřednictvím formuláře **Commercial permission** v repozitáři. Uveďte zamýšlené použití, způsob distribuce a organizaci. Podání žádosti není souhlas; počkejte na výslovnou písemnou dohodu.

Copyright © 2026 CrioMant. Kód BRAMY a původní prostředky se řídí [licencí](LICENSE.md). Oznámení a licence závislostí nadále platí pro příslušné součásti.
