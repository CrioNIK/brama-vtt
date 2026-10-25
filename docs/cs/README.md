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

Vlastnosti zdi nabízejí samostatné režimy **Žádné**, **Běžný**, **Omezený**, **Blízkost** a **Obrácená blízkost** pro vidění, světlo a zvuk. Pohyb zůstává zaškrtávacím políčkem. Žádné neblokuje; běžný režim blokuje při prvním průsečíku; omezený propustí jeden odlišný průsečík a blokuje při druhém na stejné přímce. Shodné úsečky nebo úsečky se společným koncovým bodem se počítají jako jeden průsečík: toto pravidlo definuje BRAMA. Otevřené dveře neblokují. Omezení zvuku se ukládají a podporují je geometrické dotazy; přehrávání prostorového zvuku není dostupné.

Blízkost umožňuje průchod pro blízké zdroje; obrácená blízkost pro vzdálené. Kontrola používá vzdálenost ke konečné úsečce zdi včetně jejích konců a zohledňuje velikost zdroje, pokud ji poskytuje profil vnímání. Přesně na upravené hranici se výjimka podle vzdálenosti neuplatní. Kladný práh každého kanálu zadávejte v jednotkách scény; ukládá se v pixelech, nejvýše 100 000. Prázdná (`null`) nebo chybějící hodnota znamená, že výjimka podle vzdálenosti neplatí a běžné blokování zůstává podle ostatních nastavení zdi. Změna režimů zachovává zadané vzdálenosti v konceptu; uložení režimu bez prahu vymaže vzdálenost daného kanálu. Společné nastavení **Prahový útlum** se zachovává při skrytí ovládacího prvku a ve výchozím stavu je vypnuté. Mění účinnou oblast vnímání za zdí, nikoli její neprůhlednost; samotný kolizní dotaz výsledný dosah nepopisuje.

**Blokovaná strana** nabízí **Obě strany**, **Blokovat zleva** a **Blokovat zprava**. Levá a pravá strana se určují podle orientované šipky od bodu A k bodu B, nikoli podle stran obrazovky. Živý náhled označuje A a B a zvýrazňuje nastavenou stranu zdroje; vybraná směrová stěna ukazuje stejnou orientaci na mapě. Směr filtruje zapnutá omezení vidění, světla, zvuku a pohybu podle strany zdroje před kontrolou kolizí nebo počítáním omezených průsečíků. Prohození samotných A a B obrátí fyzickou blokovanou stranu; prohození konců spolu se záměnou levé/pravé strany ji zachová. Otevřené dveře toto nastavení uchovávají, ale neblokují.

Starší booleovská nastavení zdí zůstávají kompatibilní; výslovné režimy jednotlivých kanálů mají přednost. Uložené zdi bez směru ve výchozím stavu blokují z obou stran. Import podporuje Neutral Scene 0.1–0.11 a přijímá výslovné směrové štítky s uspořádanými koncovými body ve všech těchto verzích; neznámé hodnoty směru odmítá. Omezený režim vyžaduje verzi 0.9 nebo novější. Nastavení prahů, výslovný počátek měření dosahu vidění a výslovná nastavení vnímání světla vyžadují verzi 0.11. Náhled importu započítá každou zeď s omezeným režimem jednou, i když jej používá více kanálů.

BRAMA zachovává desetinné souřadnice scény v geometrických dotazech bez zaokrouhlování na celé pixely. Pohyb určuje stranu zdroje podle středu žetonu na začátku přesunu a poté kontroluje oblast, kterou opisuje osově zarovnaný obdélník daný šířkou a výškou žetonu. Tato plocha může kolidovat, i když je dráha středového bodu volná; pohyb a bodová viditelnost mají odlišné kontrakty.

Vypravěč může měřit dosah vidění žetonu od jeho **středu** nebo **okraje žetonu**. Střed je výchozí hodnotou pro starší data. Okraj žetonu přičítá polovinu menšího zabraného rozměru ke kladnému nastavenému dosahu; dotazy stále vycházejí ze středu žetonu. Konečný dosah bez světla 0 neposkytuje vidění ve tmě ani při měření od okraje. **Neomezené vidění bez světla** je samostatná volba.

**Vnímá osvětlené oblasti** ovládá dodatečné vidění skutečně osvětlených oblastí. Jeho dosah se samostatně nastavuje jako konečný nebo neomezený; vypnutí nebo konečný dosah 0 tuto dodatečnou cestu vypne. Kladné konečné dosahy používají stejný počátek měření. Neomezený dosah odstraňuje limit vzdálenosti, ale omezení zdí a oblasti vnímání nadále platí. Starší žetony bez tohoto profilu si zachovávají zapnuté neomezené vnímání světla; jiné úpravy nevytvářejí výslovný profil.

Import scény přijímá nadbytečný záznam detekce `basicSight` pouze tehdy, když je zapnutý on i vidění, jeho dosah odpovídá metadatům vidění a neobsahuje další pole. Verze 0.11 přijímá také výslovná nastavení `lightPerception` odpovídající zdrojovým metadatům; výslovný záznam detekce vyžaduje příslušná normalizovaná nastavení. Ostatní režimy detekce, neznámá pole a nesoulady zůstávají nepodporované.

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

Rozhraní používá React a TypeScript a sestavuje se pomocí Vite. Server Node.js odpovídá za validaci příkazů, filtrování oprávnění, ukládání v SQLite a aktualizace přes WebSocket. Deníky používají Tiptap a čištění HTML. `client/` obsahuje rozhraní, `client/renderer/` vykreslování mapy, `server/` autoritativní příkazy a ukládání, `shared/` datové kontrakty a pomocná pravidla, `rust/raycast/` jádro výpočtů paprsků a `tests/` regresní testy se samostatnými testovacími daty. Překlady používají anglické klíče a pojmenované parametry; text hráčů není překladový klíč.

Prohlížeč sjednává protokol `snapshot-delta-v1`. První připojení, opětovné připojení a výslovná resynchronizace dostávají úplný snímek; starší klienti nadále dostávají úplné snímky. U dalších změn server filtruje stav kampaně samostatně pro každého příjemce a porovnává pouze jemu dostupné stavy JSON; nerozesílá nezpracované příkazy jako stav. Delty obsahují základní a výslednou revizi. Neplatný nebo chybějící základ se odmítne bez částečného použití a klient požádá o úplný snímek a pozastaví nové příkazy do dokončení synchronizace. Serializovaný základ každého spojení má limit **4 MiB**; patche jsou omezeny na **4096 operací**. Překročení těchto limitů nebo nekompatibilní identita či revize vyvolají přechod na úplný snímek; delta se odešle pouze tehdy, je-li menší. Tím se omezuje opakovaný přenos nezměněné geometrie; úplné filtrování oprávnění stále probíhá, takže tato změna nedokládá snížení jeho nároků na CPU ani zvýšení snímkové frekvence.

Výchozí vykreslování mapy zajišťuje **PixiJS 8.22.0 s WebGL**. Upřednostňuje kontext WebGL 2 a může použít WebGL 1, pokud je dostupný kontext s podporou vysoké přesnosti fragmentových shaderů. Fragmentové GL shadery analyticky vyhodnocují kruhové hranice dosahu; průniky polygonů používají stencilové masky ke skládání světla a mlhy. React zachovává ovládací prvky, interakci ukazatelem a klávesnicí a přístupné popisky objektů. **Vykreslování mapy → Porovnání SVG** výslovně zvolí zachované referenční vykreslování SVG; nejde o automatickou náhradu vydávanou za WebGL. Chyby inicializace a ztráta kontextu zobrazí zprávu s možností opakování. WebGPU, WGSL, SIMD ani ručně psaný assembler nejsou implementovány.

Dávky paprsků polygonů viditelnosti v prohlížeči používají **skalární jádro Rust/WebAssembly** s aritmetikou s dvojitou přesností. TypeScript zachovává filtrování zdrojů a tvorbu polygonů; serverové kontroly viditelnosti a pohybu zůstávají v TypeScriptu. Aplikace čeká na načtení a vlastní kontrolu jádra před připojením Reactu, aby první uložení geometrie do mezipaměti používalo vybranou implementaci. Stahování má **časový limit 8 sekund**. Chyba stahování, kompilace nebo vlastní kontroly ponechá dostupnou referenční implementaci TypeScript a zaznamená důvod přepnutí; nebrání otevření aplikace.

Distribuované jádro a manifest sestavení jsou v `public/wasm/`; běžná instalace používá tyto soubory bez nutnosti instalovat Rust. Chcete-li je znovu sestavit nebo ověřit, nainstalujte připnutou sadu nástrojů **Rust 1.98.0** a cíl **wasm32-unknown-unknown** a spusťte:

```sh
npm run wasm:build
npm run wasm:check
npm run wasm:test
```

`wasm:build` zkompiluje a nahradí distribuovaný binární soubor a manifest hashů zdrojových souborů. `wasm:check` je znovu sestaví a porovná oba s distribuovanými soubory. `wasm:test` provede aserce kontraktů Rust ve zkompilovaném cíli WebAssembly. Tyto kontroly potvrzují testované kontrakty; neprokazují zlepšení snímkové frekvence ani latence.

Stůl znovu používá neměnnou geometrii vidění a světla, když se hodnoty stěn a zdrojů shodují, a to i mezi rovnocennými snímky ze serveru. Tato omezená mezipaměť patří připojenému zobrazení a při změně scény, účastníka, role nebo úrovně se vymaže. Vlastnictví, nastavení dosahu a vizuální stav se načítají znovu; filtrování oprávnění na serveru zůstává nezávislé.

Změny musí zachovat ověřování příkazů, oprávnění, atomické zápisy a chování opakovaných pokusů. Ztráta potvrzení nedokazuje selhání příkazu. Dokud výsledek neznáte, použijte obnovu výsledku v rozhraní místo vytvoření nové operace. Viz [Přispívání](CONTRIBUTING.md) a [Bezpečnost](SECURITY.md).

## Současné hranice

Bodové dotazy ignorují stěnu, pokud jejich zdroj leží přesně na přímce obsahující stěnu, včetně jejího prodloužení za kterýkoli konec, a to i při nastavení Obě strany. Směrový pohyb tuto stěnu také ignoruje, pokud počáteční střed žetonu leží přesně na této přímce. Pohyb při nastavení Obě strany v tomto případě zachovává kontrolu kolize obdélníkové plochy žetonu. Blízké desetinné souřadnice se nezaokrouhlují na tuto přímku.

Viditelnost žetonu se ověřuje v jeho středu a v bodech uvnitř vykresleného kruhového těla: částečně odkrytý žeton může být viditelný, i když je jeho střed za zdí. Hustota vzorkování závisí na velikosti žetonu a je omezena na 257 bodů; úzký otvor mezi nimi může být stále přehlédnut. Rohy rámečku výběru, popisky ani obrysy nezajišťují viditelnost. Skrytí žetonu a oprávnění vlastníků se kontrolují samostatně. Mlha zakrývá mapu vizuálně; geometrie scény a obrázky pozadí se stále odesílají hráčům a nejsou důvěrné.

BRAMA je raná funkční aplikace. Neobsahuje kompletní pravidla, neomezené skriptování, společné slučování textu, úplný cyklus importu a exportu externích deníků, značky mapy, stránky audio/video/PDF ani veřejný hosting. Nepodporovaná importovaná pravidla se hlásí nebo odmítají, nikoli tiše provádějí. Model viditelnosti a mobilní úpravy mají výslovná omezení. Úspěšné testy potvrzují ověřené kontrakty, ne univerzální kompatibilitu ani všechny možné herní situace.

Protínající se zdi v omezeném režimu mají konzervativní hranici vykreslování: viditelnost bodu započítá shodný průsečík jednou, zatímco maska ořízne přesný paprsek nulové šířky v průsečíku, aby neotevřel širší viditelný klín. Výpočet je omezen na 32 768 porovnání dvojic zdí a 2 048 průsečíků. Překročení kteréhokoli limitu způsobí, že se omezené zdi chovají jako běžné pouze v dané vykreslené masce. To může skrýt jinak viditelné oblasti; překážky se nikdy nevynechávají a viditelnost bodů si zachovává pravidlo omezených průsečíků.

## Autor a oprávnění

Autor a správce: **CrioMant / [CrioNIK](https://github.com/CrioNIK)**. O komerční souhlas požádejte prostřednictvím formuláře **Commercial permission** v repozitáři. Uveďte zamýšlené použití, způsob distribuce a organizaci. Podání žádosti není souhlas; počkejte na výslovnou písemnou dohodu.

Copyright © 2026 CrioMant. Kód BRAMY a původní prostředky se řídí [licencí](LICENSE.md). Oznámení a licence závislostí nadále platí pro příslušné součásti.
