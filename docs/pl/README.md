# BRAMA VTT

**Wielojęzyczny wirtualny stół do gry autorstwa [CrioMant](https://github.com/CrioNIK).**

[English — oryginał](../../README.md) · [Українська](../uk/README.md) · [Español](../es/README.md) · [Polski](README.md) · [Čeština](../cs/README.md)

Tworzę BRAMĘ jako wspólną przestrzeń do opowiadania historii przy stole: mapę, postacie, kości, dzienniki i wyraźny podział między widokiem prowadzącego a widokiem każdego gracza. Aplikacja działa na Twoim komputerze i zapisuje stan kampanii w lokalnej bazie danych.

**Kod jest dostępny do użytku niekomercyjnego. Użytek komercyjny wymaga mojej uprzedniej pisemnej zgody.** Zobacz [licencję](LICENSE.md). To ograniczenie oznacza, że projekt nie jest udostępniany na licencji open source w rozumieniu OSI. Zależności zewnętrzne zachowują własne licencje wymienione w [informacjach o komponentach zewnętrznych](THIRD_PARTY_NOTICES.md).

## Dostępne możliwości

- Sceny z kwadratową siatką, poziomami, żetonami, ścianami, drzwiami, światłami, pomiarem i ograniczonym modelem widoczności.
- Oddzielne sesje prowadzącego i graczy, jawne uprawnienia oraz filtrowanie prywatnych informacji po stronie serwera.
- Karty postaci, ekwipunek, testy cech, rzuty obronne, umiejętności, zasoby, efekty i konfigurowalny rozwój.
- Koszty akcji, wyniki rzutów oraz jawne zastosowanie obrażeń lub leczenia jako osobne kroki.
- Kolejka walki z inicjatywą, rozstrzyganiem kolejności remisów, licznikami i przywracaniem poprzedniej tury.
- Dzienniki z formatowanym tekstem, obrazami, folderami, uprawnieniami dokumentów i stron, prywatnymi notatkami prowadzącego oraz pokazami dla wybranych odbiorców.
- Eksport kampanii do JSON, walidowany import dokumentów wymiany i trwałe potwierdzenia obsługiwanych poleceń.

Interfejs obsługuje **angielski, hiszpański, ukraiński, polski i czeski**. Początkowy język to ukraiński; przełącznik zapamiętuje wybór. Zmiana języka interfejsu nie tłumaczy ani nie zastępuje treści kampanii napisanej przez graczy. Oryginał dokumentacji jest angielski; pozostałe cztery wydania obejmują ten sam materiał.

## Uruchomienie lokalne

Zainstaluj **Node.js od 24.12 w ramach gałęzi 24.x**, a następnie wykonaj:

```sh
git clone https://github.com/CrioNIK/brama-vtt.git
cd brama-vtt
npm ci
npm run build
npm start
```

Otwórz **http://127.0.0.1:8015/**. Utwórz kampanię, a potem otwórz zaproszenie w innej karcie, aby dołączyć jako gracz. Prowadzący oddzielnie nadaje dostęp do żetonów i postaci. Dane sesji pozostają w danej karcie przeglądarki; zachowaj dostęp do karty prowadzącego.

Serwer celowo nasłuchuje tylko lokalnie. Zaproszenia działają na tym komputerze; hosting internetowy i odzyskiwanie kont nie są dostępne. `PORT` zmienia lokalny port, a `VTT_DB` — ścieżkę SQLite. Domyślna baza to `server/data/vtt.sqlite`.

## Gra i tworzenie materiałów

Narzędzia mapy umożliwiają wybieranie i przesuwanie obiektów, pomiar odległości oraz dodawanie żetonów, ścian, drzwi i świateł. Przed edycją wybierz scenę i poziom. Własność żetonu określa, kto nim steruje; uprawnienia karty — kto może przeglądać dane postaci.

Właściwości ściany udostępniają osobne tryby **Brak**, **Zwykły** i **Ograniczony** dla widzenia, światła i dźwięku. Ruch pozostaje polem wyboru. Brak nie blokuje; tryb zwykły blokuje przy pierwszym przecięciu; ograniczony przepuszcza jedno odrębne przecięcie i blokuje przy drugim na tej samej linii. Pokrywające się odcinki lub odcinki spotykające się w tym samym punkcie końcowym liczą się jako jedno przecięcie: taką regułę definiuje BRAMA. Otwarte drzwi nie blokują. Ograniczenia dźwięku są zapisywane i obsługiwane przez zapytania geometryczne; odtwarzanie dźwięku przestrzennego jest niedostępne.

Starsze logiczne ustawienia ścian pozostają zgodne; jawne tryby poszczególnych kanałów mają pierwszeństwo. Neutral Scene 0.9 importuje ograniczenia w trybie ograniczonym, a podgląd liczy każdą ścianę z takim trybem raz, nawet jeśli używa go kilka kanałów.

Import sceny przyjmuje pojedynczy nadmiarowy wpis wykrywania `basicSight` tylko wtedy, gdy zarówno on, jak i widzenie są włączone, jego zasięg odpowiada metadanym widzenia i nie zawiera dodatkowych pól. Inne tryby wykrywania oraz rozbieżności pozostają nieobsługiwane.

Jawnie twórz akcje postaci i ich koszty zasobów. Sprawdź koszt przed wykonaniem akcji. Udana akcja może wygenerować rzut; zastosowanie obrażeń lub leczenia jest kolejną jawną operacją. Wyświetlenie wyniku kości samo w sobie nie zmienia punktów życia.

W walce dodaj uczestników, ustaw lub rzuć inicjatywę i rozpocznij starcie. Kolejka obsługuje pokonanych uczestników, remisy, liczniki i cofnięcie poprzedniego przejścia. Nie egzekwuje wszystkich zasad gry ani nie blokuje ruchu po mapie poza turą.

Dzienniki służą do materiałów i notatek. Strony mogą dziedziczyć dostęp dokumentu lub mieć własne uprawnienia. Pokaz dla wybranych osób wysyła zapisaną kopię stron bez przyznawania stałego dostępu do oryginału. Późniejsza edycja nie zmienia tej kopii. Archiwizacja dziennika odwołuje aktywne pokazy; przywrócenie nie wysyła ich ponownie.

Regularnie eksportuj kampanię. Eksport to przenośny dokument JSON; nie zastępuje działającej bazy ani nie gwarantuje przywracania kampanii jednym kliknięciem. Aby uzyskać spójną lokalną kopię zapasową, zatrzymaj serwer przed skopiowaniem bazy i powiązanych plików SQLite. Nie umieszczaj baz kampanii, eksportów, kodów zaproszeń ani danych sesji w publicznym repozytorium.

## Rozwój i weryfikacja

```sh
npm test
npm run typecheck
npm run build
```

Aby rozwijać klienta oddzielnie, uruchom `npm run dev` oraz `npm run client` w dwóch terminalach. Vite korzysta z portu 5173 i przekazuje API oraz WebSocket do portu 8015.

Projekt używa React, TypeScript, Vite, SQLite w Node, WebSocket, Tiptap i oczyszczania HTML. `client/` zawiera interfejs, `server/` — nadrzędne polecenia i zapis danych, `shared/` — kontrakty danych i pomocnicze reguły, a `tests/` — testy regresyjne i samodzielne dane testowe. Tłumaczenia używają angielskich kluczy i nazwanych parametrów; tekst graczy nie jest kluczem tłumaczenia.

Zmiany muszą zachować walidację poleceń, uprawnienia, atomowość zapisów i zachowanie ponowień. Brak potwierdzenia nie dowodzi niepowodzenia polecenia. Skorzystaj z odzyskiwania wyniku w interfejsie zamiast tworzyć nową operację, gdy wynik poprzedniej jest nieznany. Zobacz [Współtworzenie](CONTRIBUTING.md) i [Bezpieczeństwo](SECURITY.md).

## Obecne granice

Widoczność żetonu jest sprawdzana w jego środku i w punktach wewnątrz narysowanego koła: częściowo odsłonięty żeton może być widoczny, nawet gdy jego środek znajduje się za ścianą. Gęstość próbkowania zależy od rozmiaru żetonu i jest ograniczona do 257 punktów; wąski otwór pomiędzy nimi nadal może zostać pominięty. Narożniki ramki zaznaczenia, etykiety i obrysy nie zapewniają widoczności. Ukrycie żetonu i uprawnienia właścicieli są sprawdzane oddzielnie. Mgła zasłania mapę wizualnie; geometria sceny i obrazy tła nadal trafiają do graczy i nie są poufne.

BRAMA jest wczesną działającą aplikacją. Nie obejmuje pełnego systemu zasad, dowolnych skryptów, wspólnego scalania tekstu, pełnego cyklu importu i eksportu zewnętrznych dzienników, pinezek mapy, stron audio/wideo/PDF ani publicznego hostingu. Nieobsługiwane importowane reguły są zgłaszane lub odrzucane, a nie wykonywane po cichu. Model widoczności i edycja mobilna mają określone ograniczenia. Pozytywne testy potwierdzają sprawdzone kontrakty, nie uniwersalną zgodność ani każdy możliwy scenariusz gry.

Przecinające się ściany w trybie ograniczonym mają zachowawczą granicę renderowania: widoczność punktu liczy pokrywające się przecięcie raz, a maska przycina dokładny promień o zerowej szerokości w miejscu przecięcia, aby nie otwierał szerszego widocznego klina. Obliczenia ograniczono do 32 768 porównań par ścian i 2 048 przecięć. Przekroczenie dowolnego limitu sprawia, że ściany ograniczone działają jak zwykłe wyłącznie w tej renderowanej masce. Może to zasłaniać obszary, które byłyby widoczne; przeszkody nigdy nie są pomijane, a widoczność punktowa zachowuje regułę ograniczonych przecięć.

## Autor i zgody

Autor i opiekun: **CrioMant / [CrioNIK](https://github.com/CrioNIK)**. O zgodę komercyjną poproś przez formularz **Commercial permission** w repozytorium. Opisz zamierzony użytek, model dystrybucji i organizację. Otwarcie zgłoszenia nie jest zgodą; poczekaj na wyraźne pisemne porozumienie.

Copyright © 2026 CrioMant. Kod BRAMY i oryginalne zasoby podlegają [licencji](LICENSE.md). Informacje i licencje zależności nadal obowiązują dla odpowiednich komponentów.
